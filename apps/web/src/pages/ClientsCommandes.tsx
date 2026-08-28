import { useState, useMemo, useEffect, useCallback, useRef, Fragment, type ReactNode, type ComponentType } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useHasPermission } from '@/contexts/PermissionsContext'
import {
  ShoppingCart,
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
  AlertTriangle,
  CheckCircle2,
  Clock,
  Package,
  Link2,
  Unlink,
  Printer,
  AtSign,
  FileText,
  FileCheck2,
  ReceiptText,
  Calculator,
  Upload,
  Layers,
  Box,
  Lock,
  LockOpen,
  Sparkles,
  Droplets,
  Hourglass,
  Mail,
  ClipboardList,
  Truck,
  Gift,
  Boxes,
  FileSignature,
  Percent,
} from 'lucide-react'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { Tooltip } from '@/components/ui/tooltip'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateStockCaches } from '@/lib/cache-sync'
import { postEmail } from '@/lib/email'
import { EtatPill } from '@/lib/etat-stock-fini'

// ── Types ──────────────────────────────────────────────

type ClientPhase = 'a_affecter' | 'partielle' | 'terminee'

/** Which printable/emailable document the header menus target.
 *  'donation-valeur' (the "Calcul de la valeur" of the attached pieces) only
 *  exists on donation orders. */
type CommandeDocKind = 'confirmation' | 'proforma' | 'donation-valeur'

/** API path segment per document — '' is the confirmation de commande, which
 *  hangs directly off /commandes-client/:id. */
const DOC_PATH: Record<CommandeDocKind, string> = {
  confirmation: '',
  proforma: '/proforma',
  'donation-valeur': '/donation-valeur',
}

interface CommandeListRow {
  IDcommande_client: number
  IDclient: number
  numero: number | null
  date_commande: string | null
  est_soldee: number
  client_nom: string
  phase: ClientPhase
  total_eur: number
  total_qte: number
  nb_lignes: number
  earliest_delivery: string | null
}

interface LigneCommande {
  IDligne_commande_client: number
  IDcommande_client: number
  type: number // 1=écru, 2=fini, 3=divers
  IDreference: number
  IDcolori: number
  /** Divers (type 3) only — the two ref_divers variation axes that, with
   *  IDreference, identify the exact article the line ships. */
  IDVariation1: number
  IDVariation2: number
  variation1_label: string | null
  variation2_label: string | null
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
  nb_rolls: number
  total_metrage: number
  total_poids: number
  affecte: number
  expedie: number
}

interface RollLite {
  id: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  coloris_reference: string | null
  magasin_nom: string | null
  second_choix: number | null
  observations: string | null
  /** Fini only — the ennoblisseur's defect report (stock_fini.observation_sst). */
  observation_sst: string | null
  etat_label: string | null
  /** Roll already shipped — affectation locked, no "Retirer" action. */
  expedie: boolean
}

interface AffectationPayload {
  kind: 'ecru' | 'fini' | 'none'
  unite: number
  unite_label: string
  dim: 'metrage' | 'poids'
  target_qty: number
  /** Combined affecté (rolls + écru×rendement + tricotage allocations) in the
   *  line's dim — the "854 / 800 Ml" legacy gauge. */
  affecte_total: number
  linked: RollLite[]
  available: RollLite[]
}

interface SupplyTricoRow {
  id: number
  commande_id: number
  date_commande: string | null
  sous_traitant_nom: string | null
  date_livraison: string | null
  etat_label: string
  poids_disponible: number
  poids_affecte: number
  metrage_potentiel: number
}
interface SupplyEnnoRow {
  id: number
  commande_id: number
  date_commande: string | null
  sous_traitant_nom: string | null
  date_livraison: string | null
  etat_label: string
  qte_disponible: number
  qte_affecte: number
}
interface SupplyPayload {
  applicable: boolean
  tricotage: SupplyTricoRow[]
  ennoblissement: SupplyEnnoRow[]
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

// Canonical AdresseLookup → PopoverSelect option mapper (mps_designer §11bis).
// `description` renders the full address (street · postal city · pays) under the
// name on each popover row so the user can verify the pick at a glance.
function adresseOption(a: AdresseLookup) {
  const street = [a.adresse1, a.adresse2, a.adresse3].filter(Boolean).join(' · ')
  const cityLine = [a.cp, a.ville].filter(Boolean).join(' ')
  const descLines = [street, cityLine, a.pays || ''].filter((s) => s.trim().length > 0)
  return {
    id: a.IDadresse,
    primary: a.nom || `Adresse #${a.IDadresse}`,
    secondary: a.ville ?? undefined,
    description: descLines.length > 0 ? descLines.join('\n') : undefined,
  }
}

interface CommandeDetail {
  IDcommande_client: number
  IDclient: number
  client_nom: string
  /** "Fiche client" — client.commentaire: customer-specific handling notes
   *  (procedures, contrôle rules…) surfaced on every commande like legacy. */
  client_fiche: string | null
  numero: number | null
  date_commande: string | null
  ref_client: string | null
  IDadresse_livraison: number
  IDadresse_facturation: number
  IDmode_paiement: number
  IDecheance: number
  commentaire: string | null
  commentaire_interne: string | null
  observations_facturation: string | null
  est_soldee: number
  donation: number
  /** Stock pieces attached via IDcommande_donation (donation orders only). */
  nb_donation_pieces: number
  remise: number
  frais_port: number
  IDdossier: number
  adresse_livraison: AdresseLite | null
  adresse_facturation: AdresseLite | null
  lignes: LigneCommande[]
  tombe_metier: TombeMetierRow[]
  phase: ClientPhase
}

interface TombeMetierRow { IDref_ecru: number; ref_label: string; coloris_label: string; poids_kg: number }

/** A stock piece attached (or attachable) to a donation commande — écru
 *  (tombé de métier) or fini, keyed by its stock table id. */
interface DonationPiece {
  id: number
  ref_label: string | null
  coloris_reference: string | null
  numero: string | null
  poids: number
  metrage: number
  lot: string | null
  date_saisie: string | null
  second_choix: number
  observations: string | null
  defauts: string | null
  attached: 0 | 1
}
interface DonationPayload { ecru: DonationPiece[]; fini: DonationPiece[] }

interface ClientLite { IDclient: number; nom: string; IDmode_paiement?: number; IDecheance?: number }
interface ModePaiement { IDmode_paiement: number; libelle: string }
interface Echeance { IDecheance: number; libelle: string }
interface RefEcru { IDref_ecru: number; reference: string }
interface RefFini { IDref_fini: number; reference: string; designation: string; avec_teinture: number }
/** ref_divers catalog row (from the shared /expeditions/divers lookup — it
 *  carries the two variation-axis labels the line form needs). */
interface RefDivers {
  IDref_divers: number
  designation: string
  unite: number
  unite_label: string
  archive: number
  sTypeVariation1: string
  sTypeVariation2: string
}
interface RefDiversVariation {
  IDref_divers_variation: number
  designation: string
  niveau: number
}
/** `hors_catalogue` = this coloris is not one the client has registered on the
 *  reference in Clients › Gestion (only ever true for the coloris an existing
 *  line already carries, or when the client has no catalogue on that ref). */
interface ColoriOption { id: number; reference: string; hors_catalogue?: boolean }
interface LinePriceInfo {
  prix: number | null
  unite: number
  unite_label: string
  rollSize: number
  nRolls: number
  cleanQty: number
  exact: boolean
  trancheRolls: number
  nextTrancheRolls: number
  nextTrancheQty: number
  nextTrancheGapQty: number
  nextTranchePrix: number | null
  nearNextTranche: boolean
  priceable: boolean
  /** Which grid priced the line for THIS client on this (référence × coloris):
   *  contrat négocié, coefficient fixe, or the standard catalogue grid. */
  tarif_mode: 'standard' | 'coefficient' | 'contrat'
  coefficient: number
  /** Contract mode with no contract covering today — the line is refused. */
  contrat_expire: boolean
  contrat_date_expiration: string
  blocked: boolean
  blocked_reason: string | null
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Status / phase helpers ─────────────────────────────

const PHASE_META: Record<ClientPhase, { label: string; solid: string; icon: React.ElementType }> = {
  a_affecter: { label: 'À affecter', solid: 'bg-slate-500 border-slate-500', icon: Package },
  partielle: { label: 'Affectée', solid: 'bg-primary border-primary', icon: Link2 },
  terminee: { label: 'Terminée', solid: 'bg-success border-success', icon: CheckCircle2 },
}

function PhasePill({ phase, className }: { phase: ClientPhase; className?: string }) {
  const meta = PHASE_META[phase] ?? PHASE_META.a_affecter
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solid, className)}>
      <Icon className="h-2.5 w-2.5" />{meta.label}
    </Badge>
  )
}

// Supply-line état pill — solid hue per sst line status, matching the colors
// used by the Sous-traitants/Commandes phase pills (SST_PHASE_META). Keyed on
// the French label the supply endpoint emits (SSTATUT_LABELS).
const SUPPLY_ETAT_META: Record<string, { solid: string; icon: React.ElementType }> = {
  'En cours': { solid: 'bg-primary border-primary', icon: Clock },
  'Attente délai': { solid: 'bg-yellow-500 border-yellow-500', icon: Hourglass },
  'Non envoyé': { solid: 'bg-slate-500 border-slate-500', icon: Mail },
}

function SupplyEtatPill({ label }: { label: string | null | undefined }) {
  if (!label) return <span className="text-muted-foreground">—</span>
  const meta = SUPPLY_ETAT_META[label]
  if (!meta) return <span className="text-muted-foreground">{label}</span>
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solid)}>
      <Icon className="h-2.5 w-2.5" />{label}
    </Badge>
  )
}

// Line type chip — category color per écru / fini / divers.
function lineTypeChip(type: number): { label: string; classes: string } | null {
  if (type === 1) return { label: 'Écru', classes: 'bg-amber-500/15 text-amber-800 border border-amber-500/30' }
  if (type === 2) return { label: 'Fini', classes: 'bg-sky-500/10 text-sky-700 border border-sky-500/25' }
  if (type === 3) return { label: 'Divers', classes: 'bg-stone-500/10 text-stone-700 border border-stone-500/25' }
  return null
}

// Delivery-urgency flag based on the earliest line delivery date.
function deliveryUrgency(earliestHfsql: string | null, estSoldee: number): 'late' | 'soon' | null {
  if (estSoldee === 1) return null
  if (!earliestHfsql || !/^\d{8}$/.test(earliestHfsql)) return 'late'
  const target = new Date(Number(earliestHfsql.slice(0, 4)), Number(earliestHfsql.slice(4, 6)) - 1, Number(earliestHfsql.slice(6, 8)))
  target.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'late'
  if (diffDays <= 3) return 'soon'
  return null
}

function lineCardColors(line: LigneCommande) {
  // Fully-reserved → green; some reserved → amber; none → neutral.
  if (line.type === 3) return { border: 'border-l-stone-400/60', iconBg: 'bg-stone-400/10', iconColor: 'text-stone-600' }
  const target = Number(line.quantite) || 0
  const done = target > 0 && line.affecte >= target - 0.001
  if (done) return { border: 'border-l-green-500/60', iconBg: 'bg-green-500/10', iconColor: 'text-green-600' }
  if (line.nb_rolls > 0) return { border: 'border-l-amber-400/60', iconBg: 'bg-amber-400/10', iconColor: 'text-amber-600' }
  return { border: 'border-l-border', iconBg: 'bg-muted', iconColor: 'text-muted-foreground' }
}

// ── Main Page ──────────────────────────────────────────

export function ClientsCommandes() {
  const queryClient = useQueryClient()
  const canMarkDonation = useHasPermission('donation_commande_client')
  // Create / edit / delete commandes + lignes. Without it, no "Nouvelle" and
  // no "Modifier" — the screen is read-only (view-mode workflows stay open).
  const canEditCommandes = useHasPermission('edit_commandes_client')
  // Print / email the facture proforma. Without it the doc menus collapse to
  // their single remaining entry (confirmation de commande) and act directly.
  const canProforma = useHasPermission('proforma_commande_client')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'terminee'>('open')
  // Amber counter-pill toggle: narrow the list to commandes non affectées.
  const [amberOnly, setAmberOnly] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [affectationLineId, setAffectationLineId] = useState<number | null>(null)
  // Which document the email dialog targets — null = dialog closed.
  const [emailDoc, setEmailDoc] = useState<CommandeDocKind | null>(null)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteCommandeConfirmOpen, setDeleteCommandeConfirmOpen] = useState(false)
  // Whole-order divers shipment editor (header button, divers orders only).
  const [expGroupeeOpen, setExpGroupeeOpen] = useState(false)

  // Edit-mode header draft.
  const [editDateCommande, setEditDateCommande] = useState('')
  const [editRefClient, setEditRefClient] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')
  const [editCommentaireInterne, setEditCommentaireInterne] = useState('')
  const [editIDModePaiement, setEditIDModePaiement] = useState(0)
  const [editIDEcheance, setEditIDEcheance] = useState(0)
  const [editRemise, setEditRemise] = useState('')
  const [editFraisPort, setEditFraisPort] = useState('')
  const [editDonation, setEditDonation] = useState(false)
  const [editIDAdresseFacturation, setEditIDAdresseFacturation] = useState(0)
  const [editIDAdresseLivraison, setEditIDAdresseLivraison] = useState(0)

  const originalDraftRef = useRef<Record<string, string | number> | null>(null)
  const [linesDirty, setLinesDirty] = useState(false)

  // Debounce search (server-side).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  const { data: commandes, isLoading, isError, error, isFetching } = useQuery<CommandeListRow[]>({
    queryKey: ['commandes-client', statusFilter, debouncedQuery],
    queryFn: () => apiFetch(`/commandes-client?status=${statusFilter}&q=${encodeURIComponent(debouncedQuery)}&limit=200`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<CommandeDetail>({
    queryKey: ['commande-client', selectedId],
    queryFn: () => apiFetch(`/commandes-client/${selectedId}`),
    enabled: selectedId !== null,
  })

  useEffect(() => { setAffectationLineId(null) }, [selectedId])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['commandes-client'] })
    queryClient.invalidateQueries({ queryKey: ['commande-client', selectedId] })
    // Affectation drawers cache the available/linked rolls per line; editing a
    // line (e.g. changing its coloris) changes which rolls are eligible, so the
    // pieces query must be invalidated too or the drawer shows a stale list.
    queryClient.invalidateQueries({ queryKey: ['commande-client-pieces'] })
    // Supply (tricotage/ennoblissement) disponible/affecté depends on roll
    // affectation, so refresh it after any line/affectation mutation too.
    queryClient.invalidateQueries({ queryKey: ['commande-client-supply'] })
    // Donation pieces attached to the selected commande (donation orders).
    queryClient.invalidateQueries({ queryKey: ['commande-client-donation', selectedId] })
  }, [queryClient, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      dateCommande: hfsqlDateToInput(detail.date_commande),
      refClient: detail.ref_client?.trim() ?? '',
      commentaire: detail.commentaire?.trim() ?? '',
      commentaireInterne: detail.commentaire_interne?.trim() ?? '',
      IDmodePaiement: detail.IDmode_paiement ?? 0,
      IDecheance: detail.IDecheance ?? 0,
      remise: detail.remise ? String(detail.remise) : '',
      fraisPort: detail.frais_port ? String(detail.frais_port) : '',
      donation: detail.donation ? 1 : 0,
      IDadresseFact: detail.IDadresse_facturation ?? 0,
      IDadresseLiv: detail.IDadresse_livraison ?? 0,
    }
    setEditDateCommande(snapshot.dateCommande)
    setEditRefClient(snapshot.refClient)
    setEditCommentaire(snapshot.commentaire)
    setEditCommentaireInterne(snapshot.commentaireInterne)
    setEditIDModePaiement(snapshot.IDmodePaiement)
    setEditIDEcheance(snapshot.IDecheance)
    setEditRemise(snapshot.remise)
    setEditFraisPort(snapshot.fraisPort)
    setEditDonation(snapshot.donation === 1)
    setEditIDAdresseFacturation(snapshot.IDadresseFact)
    setEditIDAdresseLivraison(snapshot.IDadresseLiv)
    originalDraftRef.current = snapshot
    setAffectationLineId(null)
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editDateCommande !== o.dateCommande) return true
    if (editRefClient !== o.refClient) return true
    if (editCommentaire !== o.commentaire) return true
    if (editCommentaireInterne !== o.commentaireInterne) return true
    if (editIDModePaiement !== o.IDmodePaiement) return true
    if (editIDEcheance !== o.IDecheance) return true
    if (editRemise !== o.remise) return true
    if (editFraisPort !== o.fraisPort) return true
    if ((editDonation ? 1 : 0) !== o.donation) return true
    if (editIDAdresseFacturation !== o.IDadresseFact) return true
    if (editIDAdresseLivraison !== o.IDadresseLiv) return true
    if (linesDirty) return true
    return false
  }, [isEditing, editDateCommande, editRefClient, editCommentaire, editCommentaireInterne, editIDModePaiement, editIDEcheance, editRemise, editFraisPort, editDonation, editIDAdresseFacturation, editIDAdresseLivraison, linesDirty])

  const saveHeaderMut = useMutation({
    mutationFn: () => apiFetch(`/commandes-client/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        date_commande: inputDateToHfsql(editDateCommande),
        ref_client: editRefClient,
        commentaire: editCommentaire,
        commentaire_interne: editCommentaireInterne,
        IDmode_paiement: editIDModePaiement || 0,
        IDecheance: editIDEcheance || 0,
        remise: Number(editRemise) || 0,
        frais_port: Number(editFraisPort) || 0,
        // Permission-gated field — omit entirely when the user can't set it.
        ...(canMarkDonation ? { donation: editDonation ? 1 : 0 } : {}),
        IDadresse_facturation: editIDAdresseFacturation || 0,
        IDadresse_livraison: editIDAdresseLivraison || 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/commandes-client/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<CommandeListRow[]>(['commandes-client', statusFilter, debouncedQuery]) ?? []
      const remaining = cached.filter((c) => c.IDcommande_client !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['commandes-client'] })
      setIsEditing(false)
      setDeleteCommandeConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDcommande_client : null)
    },
  })

  useEffect(() => {
    if (autoEditForId !== null && detail?.IDcommande_client === autoEditForId) {
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
    mutationFn: (newEtat: number) => apiFetch(`/commandes-client/${selectedId}/etat`, {
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

  const rows = commandes ?? []

  // "Non affectée" counter pill (mps_designer §41): open commandes with no
  // roll reserved yet, counted over the loaded list. The toggle narrows the
  // list to those cards; it disarms implicitly when the bucket empties (the
  // pill is hidden at 0, so an armed empty filter would strand the user on
  // an empty list with no visible way out).
  const amberCount = rows.reduce((n, r) => n + (r.phase === 'a_affecter' ? 1 : 0), 0)
  const amberActive = amberOnly && amberCount > 0
  const visibleRows = amberActive ? rows.filter((r) => r.phase === 'a_affecter') : rows

  // Keep the selection valid against the (server-filtered) list. Skip while the
  // list is refetching: after creating a commande we setSelectedId(newId) before
  // the refetch settles, so the stale list wouldn't yet contain it — resetting
  // here would clobber the new selection (and break the auto-enter-edit flow).
  useAutoSelectFirst({
    rows: visibleRows,
    selectedId,
    getId: (c) => c.IDcommande_client,
    select: setSelectedId,
    suspended: isEditing || isFetching,
  })

  return (
    <>
      <MasterDetailLayout
        list={
          <CommandeList
            rows={visibleRows}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={handleStatusFilterChange}
            amberCount={amberCount}
            amberOn={amberActive}
            onToggleAmber={() => setAmberOnly((v) => !v)}
            onNew={() => setCreateOpen(true)}
            canCreate={canEditCommandes}
            isEditing={isEditing}
          />
        }
        detailHeader={
          <DetailHeader
            commande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            canEdit={canEditCommandes}
            canProforma={canProforma}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveHeaderMut.mutate()}
            isSaving={saveHeaderMut.isPending}
            onDelete={() => setDeleteCommandeConfirmOpen(true)}
            onPrintDoc={(doc) => {
              if (selectedId === null) return
              window.open(`${API_URL}/commandes-client/${selectedId}${DOC_PATH[doc]}/pdf`, '_blank')
            }}
            onEmailDoc={setEmailDoc}
            onOpenExpeditionGroupee={() => setExpGroupeeOpen(true)}
          />
        }
        detail={
          <DetailMain
            commande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            editDonation={editDonation}
            onMutationSuccess={invalidateAll}
            onLinesDirtyChange={setLinesDirty}
            affectationLineId={affectationLineId}
            onOpenAffectation={setAffectationLineId}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            commande={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editDateCommande={editDateCommande} onEditDateCommandeChange={setEditDateCommande}
            editRefClient={editRefClient} onEditRefClientChange={setEditRefClient}
            editCommentaire={editCommentaire} onEditCommentaireChange={setEditCommentaire}
            editCommentaireInterne={editCommentaireInterne} onEditCommentaireInterneChange={setEditCommentaireInterne}
            editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={setEditIDModePaiement}
            editIDEcheance={editIDEcheance} onEditIDEcheanceChange={setEditIDEcheance}
            editRemise={editRemise} onEditRemiseChange={setEditRemise}
            editFraisPort={editFraisPort} onEditFraisPortChange={setEditFraisPort}
            editDonation={editDonation} onEditDonationChange={setEditDonation}
            editIDAdresseFacturation={editIDAdresseFacturation} onEditIDAdresseFacturationChange={setEditIDAdresseFacturation}
            editIDAdresseLivraison={editIDAdresseLivraison} onEditIDAdresseLivraisonChange={setEditIDAdresseLivraison}
            onToggleEtat={() => toggleEtatMut.mutate(detail?.est_soldee === 1 ? 0 : 1)}
            isTogglingEtat={toggleEtatMut.isPending}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateCommandeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['commandes-client'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      {detail && (
        <ExpeditionGroupeeDialog
          open={expGroupeeOpen}
          commande={detail}
          onClose={() => setExpGroupeeOpen(false)}
          onMutationSuccess={invalidateAll}
        />
      )}

      <ConfirmDialog
        open={deleteCommandeConfirmOpen}
        title="Supprimer la commande"
        description="Cette action supprimera la commande, ses lignes et libérera le stock affecté. Elle est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteCommandeConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />

      {selectedId !== null && (
        <SendEmailDialog
          open={emailDoc !== null}
          onClose={() => setEmailDoc(null)}
          contextLabel={detail?.client_nom ?? undefined}
          queryKey={['commande-client-email-defaults', selectedId, emailDoc ?? 'confirmation']}
          loadDefaults={() => apiFetch(`/commandes-client/${selectedId}${DOC_PATH[emailDoc ?? 'confirmation']}/email-defaults`)}
          pdfUrl={`${API_URL}/commandes-client/${selectedId}${DOC_PATH[emailDoc ?? 'confirmation']}/pdf`}
          pdfAttachmentLabel={emailDoc === 'proforma'
            // 1_000_000 offset mirrors PROFORMA_NUMERO_OFFSET in the API —
            // the proforma numero that can't collide with facturation's.
            ? `proforma-${detail?.numero ? 1_000_000 + Number(detail.numero) : selectedId}.pdf`
            : emailDoc === 'donation-valeur'
              ? `calcul-valeur-donation-${detail?.numero ?? selectedId}.pdf`
              : `confirmation-commande-${selectedId}.pdf`}
          // CGV ride along on the confirmation only — the proforma and the
          // donation valuation are standalone documents.
          extraServerAttachments={emailDoc === 'confirmation' ? [
            { id: 'cgv', label: 'CGV - ETS Malterre.pdf', url: `${API_URL}/commandes-client/cgv/pdf` },
          ] : undefined}
          onSend={async (p) => {
            await postEmail(`${API_URL}/commandes-client/${selectedId}${DOC_PATH[emailDoc ?? 'confirmation']}/email`, p, { includeAttachPdf: true })
            // Both sends log an envoi_email row server-side — refresh the
            // historique tab without a manual reload.
            queryClient.invalidateQueries({ queryKey: ['commande-client-historique', selectedId] })
          }}
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
  amberCount, amberOn, onToggleAmber,
  onNew, canCreate, isEditing,
}: {
  rows: CommandeListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statusFilter: 'all' | 'open' | 'terminee'
  onStatusFilterChange: (s: 'all' | 'open' | 'terminee') => void
  /** Count of loaded commandes non affectées — shown as the amber counter
   *  pill right of the search input (mps_designer §41). 0 hides the pill. */
  amberCount: number
  amberOn: boolean
  onToggleAmber: () => void
  onNew: () => void
  canCreate: boolean
  isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Rechercher (n°, client, réf...)"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              autoComplete="off"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {/* Amber counter pill: commandes non affectées. Number-only toggle
              flush right of the search input, hidden when the bucket is
              empty (mps_designer §41). */}
          {amberCount > 0 && (
            <button
              type="button"
              onClick={onToggleAmber}
              aria-pressed={amberOn}
              title="Commandes non affectées"
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                amberOn
                  ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                  : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
              )}
            >
              {amberCount}
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {([
            { key: 'open', label: 'En cours' },
            { key: 'terminee', label: 'Soldées' },
            { key: 'all', label: 'Toutes' },
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
            <ShoppingCart className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune commande</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.IDcommande_client
          // Neutral by default (mps_designer §41): the amber liseré flags
          // commandes non affectées (no roll reserved yet). Delivery urgency
          // no longer colors the list cards on this screen.
          const isAmber = row.phase === 'a_affecter'
          const selectedRingClass = isAmber
            ? 'border-amber-500 ring-1 ring-amber-500'
            : 'border-zinc-400 ring-1 ring-zinc-400'
          const hoverClass = isAmber
            ? 'border-border hover:border-amber-500/50'
            : 'border-border hover:border-zinc-400/60'
          return (
            <div
              key={row.IDcommande_client}
              onClick={() => onSelect(row.IDcommande_client)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected ? selectedRingClass : hoverClass,
                isAmber && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
              )}
            >
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm">N° {row.numero ?? row.IDcommande_client}</span>
                <PhasePill phase={row.phase} className="ml-auto" />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{row.client_nom || '—'}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                {row.date_commande && <span>{formatHfsqlDate(row.date_commande)}</span>}
                <span className="ml-auto text-muted-foreground/70">{row.nb_lignes} ligne{row.nb_lignes > 1 ? 's' : ''}</span>
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

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} commande{rows.length !== 1 ? 's' : ''}</span>
        {!isEditing && canCreate && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouvelle
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

/** Icon button opening a small popover menu — the print/email header buttons
 *  use it to pick which document (confirmation vs proforma) to act on.
 *  With a single document left (donation order, or no proforma permission) it
 *  drops the menu and fires that document directly — mps_designer §42.3.
 *  Pattern: PrintMenuButton in ClientsExpeditions.tsx. */
function DocMenuButton({ icon: TriggerIcon, title, items, onSelect }: {
  icon: ComponentType<{ className?: string }>
  title: string
  items: Array<{ key: CommandeDocKind; label: string; icon: ComponentType<{ className?: string }> }>
  onSelect: (key: CommandeDocKind) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Click outside to close the menu.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Single document → plain direct-action button, no chooser.
  if (items.length === 1) {
    const only = items[0]
    return (
      <Button
        variant="outline" size="icon" className="h-9 w-9"
        title={`${title} : ${only.label}`}
        onClick={() => onSelect(only.key)}
      >
        <TriggerIcon className="h-4 w-4" />
      </Button>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <Button variant="outline" size="icon" className="h-9 w-9" title={title} onClick={() => setMenuOpen((v) => !v)}>
        <TriggerIcon className="h-4 w-4" />
      </Button>
      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 w-64 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {items.map((item) => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => { onSelect(item.key); setMenuOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
              >
                <ItemIcon className="h-4 w-4 text-muted-foreground" />
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DetailHeader({
  commande, isLoading, isEditing, canEdit, canProforma,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onPrintDoc, onEmailDoc, onOpenExpeditionGroupee,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  isEditing: boolean
  canEdit: boolean
  canProforma: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintDoc: (doc: CommandeDocKind) => void
  onEmailDoc: (doc: CommandeDocKind) => void
  onOpenExpeditionGroupee: () => void
}) {
  if (!commande && !isLoading) return null
  // Donation orders never produce an invoice — no proforma menu entry. Same
  // for users without the proforma permission: they keep the confirmation
  // only, and DocMenuButton then fires it directly instead of opening a menu.
  const showProforma = canProforma && commande?.donation !== 1
  // Donation orders get the "Calcul de la valeur" of their attached pieces
  // instead — the legacy ETAT_ValeurDonation report.
  const showDonationValeur = commande?.donation === 1
  const docItems: Array<{ key: CommandeDocKind; label: string; icon: ComponentType<{ className?: string }> }> = [
    { key: 'confirmation', label: 'Confirmation de commande', icon: FileCheck2 },
    ...(showProforma ? [{ key: 'proforma' as const, label: 'Facture proforma', icon: ReceiptText }] : []),
    ...(showDonationValeur ? [{ key: 'donation-valeur' as const, label: 'Calcul de la valeur', icon: Calculator }] : []),
  ]
  // Divers lines ship through the expedition_divers ledger, which is organised
  // per carton across the whole order — hence a dedicated grouped-shipment
  // editor, offered only when the order actually carries such a line.
  const hasDiversLines = (commande?.lignes ?? []).some((l) => l.type === 3)
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
                N° {commande?.numero ?? commande?.IDcommande_client}
                <span className="text-muted-foreground font-normal"> · {commande?.client_nom || '—'}</span>
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
                {hasDiversLines && (
                  <Button variant="outline" size="icon" className="h-9 w-9" title="Expédition groupée" onClick={onOpenExpeditionGroupee}>
                    <Boxes className="h-4 w-4" />
                  </Button>
                )}
                <DocMenuButton icon={Printer} title="Imprimer" items={docItems} onSelect={onPrintDoc} />
                <DocMenuButton icon={AtSign} title="Envoyer un email" items={docItems} onSelect={onEmailDoc} />
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

// ── Center: Detail Main ────────────────────────────────

function DetailMain({
  commande, isLoading, hasSelection, isEditing, editDonation, onMutationSuccess, onLinesDirtyChange, affectationLineId, onOpenAffectation,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  editDonation: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  affectationLineId: number | null
  onOpenAffectation: (lineId: number | null) => void
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

  // Donation orders carry stock pieces instead of lignes — the whole center
  // panel swaps to the donation view (mirrors the legacy "Donation" tab).
  // While editing, the layout follows the *draft* toggle so flipping Donation
  // swaps the panel instantly; content mutations (add ligne / add pieces) stay
  // gated until the flag is saved, so cancelling the edit can't leave orphaned
  // lignes on a donation order or donation pieces on a normal one.
  const effectiveDonation = isEditing ? editDonation : commande.donation === 1
  const donationPending = isEditing && editDonation !== (commande.donation === 1)

  if (effectiveDonation) {
    return (
      <DonationSection
        commande={commande}
        isEditing={isEditing}
        pendingSave={donationPending}
        onMutationSuccess={onMutationSuccess}
      />
    )
  }

  const totalEur = commande.lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0)

  return (
    <LignesSection
      commande={commande}
      isEditing={isEditing}
      donationPending={donationPending}
      totalEur={totalEur}
      onMutationSuccess={onMutationSuccess}
      onLinesDirtyChange={onLinesDirtyChange}
      affectationLineId={affectationLineId}
      onOpenAffectation={onOpenAffectation}
    />
  )
}

// ── Center: Lignes Section ─────────────────────────────

const emptyLineForm = {
  type: 2,
  IDreference: 0,
  IDcolori: 0,
  // Divers only — the two ref_divers variation axes (0 = none).
  IDVariation1: 0,
  IDVariation2: 0,
  quantite: '',
  unite: 3,
  prix: '',
  date_livraison: '',
  commentaire: '',
}
type LineFormState = typeof emptyLineForm

function LignesSection({
  commande, isEditing, donationPending, totalEur, onMutationSuccess, onLinesDirtyChange, affectationLineId, onOpenAffectation,
}: {
  commande: CommandeDetail
  isEditing: boolean
  /** Donation flag toggled off in the draft but not saved yet — adding lignes is blocked until save. */
  donationPending: boolean
  totalEur: number
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  affectationLineId: number | null
  onOpenAffectation: (lineId: number | null) => void
}) {
  const [lineDialogOpen, setLineDialogOpen] = useState(false)
  const [editingLine, setEditingLine] = useState<LigneCommande | null>(null)
  const [deleteLineConfirmId, setDeleteLineConfirmId] = useState<number | null>(null)

  const linesLocked = commande.est_soldee === 1

  useEffect(() => {
    if (!isEditing || linesLocked) { setLineDialogOpen(false); setEditingLine(null) }
  }, [isEditing, linesLocked])

  useEffect(() => {
    onLinesDirtyChange(lineDialogOpen)
  }, [lineDialogOpen, onLinesDirtyChange])

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/commandes-client/lignes/${lineId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const startAddLine = () => { setEditingLine(null); setLineDialogOpen(true) }
  const startEditLine = (l: LigneCommande) => { setEditingLine(l); setLineDialogOpen(true) }

  const drawerOpen = affectationLineId !== null && !isEditing
  const drawerLigne = drawerOpen
    ? commande.lignes.find((l) => l.IDligne_commande_client === affectationLineId) ?? null
    : null

  // When a line's drawer opens, collapse the list to that line's height and slide it
  // up to the top so the drawer claims all the space below it — identical behaviour for
  // any line. Closing restores the full list and scrolls back to the original top.
  const listScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = listScrollRef.current
    if (!container) return
    if (affectationLineId !== null && !isEditing) {
      const raf = requestAnimationFrame(() => {
        const el = container.querySelector(`[data-line-id="${affectationLineId}"]`) as HTMLElement | null
        if (!el) return
        const cs = getComputedStyle(container)
        const padTop = parseFloat(cs.paddingTop) || 0
        const padBottom = parseFloat(cs.paddingBottom) || 0
        // Collapse the viewport to one line *instantly* (no height transition) so the
        // scroll target below is measured against the final geometry, not a mid-anim
        // height — otherwise the browser clamps the smooth scroll and the line lands short.
        container.style.maxHeight = `${el.offsetHeight + padTop + padBottom}px`
        // Absolute target = current scroll + how far the line sits below the viewport top.
        const target = container.scrollTop + (el.getBoundingClientRect().top - container.getBoundingClientRect().top) - padTop
        container.scrollTo({ top: target, behavior: 'smooth' })
      })
      return () => cancelAnimationFrame(raf)
    }
    container.style.maxHeight = ''
    container.scrollTo({ top: 0, behavior: 'smooth' })
  }, [affectationLineId, isEditing])

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div ref={listScrollRef} className={cn('overflow-auto space-y-2 p-1 scrollbar-transparent', drawerOpen ? 'flex-shrink-0' : 'flex-1 min-h-0')}>
          {commande.lignes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Layers className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune ligne</p>
              {isEditing && !linesLocked && (
                donationPending ? (
                  <p className="text-xs italic mt-3">Enregistrez la commande pour pouvoir ajouter des lignes.</p>
                ) : (
                  <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
                  </Button>
                )
              )}
            </div>
          ) : (
            commande.lignes.map((l) => (
              <LineCard
                key={l.IDligne_commande_client}
                line={l}
                isEditing={isEditing}
                linesLocked={linesLocked}
                isDrawerOpen={affectationLineId === l.IDligne_commande_client}
                onEdit={() => startEditLine(l)}
                onDelete={() => setDeleteLineConfirmId(l.IDligne_commande_client)}
                onOpenAffectation={onOpenAffectation}
              />
            ))
          )}

          {isEditing && !linesLocked && !donationPending && commande.lignes.length > 0 && (
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

        {drawerOpen && drawerLigne && (
          <div className="flex-1 min-h-0 flex flex-col mt-3 rounded-lg border border-border/60 overflow-hidden bg-zinc-50/80 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
            {drawerLigne.type === 3 ? (
              <DiversLineDrawer
                key={drawerLigne.IDligne_commande_client}
                commandeId={commande.IDcommande_client}
                ligne={drawerLigne}
                soldee={Number(commande.est_soldee) === 1}
                onClose={() => onOpenAffectation(null)}
                onSuccess={onMutationSuccess}
              />
            ) : (
              <AffectationDrawer
                key={drawerLigne.IDligne_commande_client}
                commandeId={commande.IDcommande_client}
                ligne={drawerLigne}
                clientNom={commande.client_nom}
                soldee={Number(commande.est_soldee) === 1}
                onClose={() => onOpenAffectation(null)}
                onSuccess={onMutationSuccess}
              />
            )}
          </div>
        )}

        {commande.lignes.length > 0 && (
          <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-sm font-medium">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Total · {commande.lignes.length} ligne{commande.lignes.length > 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-4 tabular-nums">
              <span className="text-accent text-base">{fmtNum(totalEur, 2)} €</span>
            </div>
          </div>
        )}
      </div>

      <LineFormDialog
        open={lineDialogOpen}
        commande={commande}
        line={editingLine}
        onClose={() => { setLineDialogOpen(false); setEditingLine(null) }}
        onSuccess={() => { setLineDialogOpen(false); setEditingLine(null); onMutationSuccess() }}
      />

      <ConfirmDialog
        open={deleteLineConfirmId !== null}
        title="Supprimer la ligne"
        description="Cette ligne sera supprimée et son stock affecté sera libéré."
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

// ── Center: Donation Section ───────────────────────────
// Donation orders (commande_client.donation = 1) have no lignes — instead
// stock pieces (tombé de métier + fini) point at the commande via
// IDcommande_donation. This section lists the attached pieces grouped by
// kind, with the legacy totals footer, and opens the full-stock picker.

const DONATION_COLS: { label: string; width: string; align?: 'right' | 'center' }[] = [
  { label: 'Référence', width: '10%' },
  { label: 'Coloris', width: '14%' },
  { label: 'Numéro', width: '10%' },
  { label: 'Poids', width: '8%', align: 'right' },
  { label: 'Métrage', width: '8%', align: 'right' },
  { label: 'Lot', width: '10%' },
  { label: 'Saisie', width: '9%' },
  { label: '2nd', width: '5%', align: 'center' },
  { label: 'Observations', width: '26%' },
]

/** The 9 shared cells of a donation piece row (section table + picker table). */
function DonationPieceCells({ p }: { p: DonationPiece }) {
  return (
    <>
      <td className="px-2.5 py-1.5 truncate font-medium" title={p.ref_label ?? undefined}>{p.ref_label || '—'}</td>
      <td className="px-2.5 py-1.5 truncate" title={p.coloris_reference ?? undefined}>{p.coloris_reference || '—'}</td>
      <td className="px-2.5 py-1.5 truncate tabular-nums" title={p.numero ?? undefined}>{p.numero || '—'}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">{p.poids ? `${fmtNum(p.poids, 2)} kg` : '—'}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">{p.metrage ? `${fmtNum(p.metrage, 2)} ml` : '—'}</td>
      <td className="px-2.5 py-1.5 truncate" title={p.lot ?? undefined}>{p.lot || '—'}</td>
      <td className="px-2.5 py-1.5 tabular-nums text-xs whitespace-nowrap">{p.date_saisie ? formatHfsqlDate(p.date_saisie) : '—'}</td>
      <td className="px-2.5 py-1.5 text-center">
        {!!p.second_choix && <span className="inline-block px-1 rounded bg-amber-400/15 text-amber-700 text-[10px] font-semibold">2nd</span>}
      </td>
      <td className="px-2.5 py-1.5">
        {!!p.observations && <p className="truncate text-xs text-muted-foreground" title={p.observations}>{p.observations}</p>}
        {!!p.defauts && (
          <p className="flex items-center gap-1 text-[11px] text-amber-700" title={p.defauts}>
            <AlertCircle className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{p.defauts}</span>
          </p>
        )}
        {!p.observations && !p.defauts && <span className="text-muted-foreground">—</span>}
      </td>
    </>
  )
}

function DonationSection({
  commande, isEditing, pendingSave, onMutationSuccess,
}: {
  commande: CommandeDetail
  isEditing: boolean
  /** Donation flag toggled on in the draft but not saved yet — attaching pieces is blocked until save. */
  pendingSave: boolean
  onMutationSuccess: () => void
}) {
  const commandeId = commande.IDcommande_client
  const [pickerOpen, setPickerOpen] = useState(false)
  const locked = commande.est_soldee === 1

  const { data, isLoading } = useQuery<DonationPayload>({
    queryKey: ['commande-client-donation', commandeId],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/donation-pieces`),
  })

  // The picker is an edit-mode affordance — close it when leaving edit mode
  // (or when the commande gets soldée under us).
  useEffect(() => { if (!isEditing || locked) setPickerOpen(false) }, [isEditing, locked])

  const ecru = data?.ecru ?? []
  const fini = data?.fini ?? []
  const nb = ecru.length + fini.length
  const totalPoids = ecru.reduce((s, p) => s + (Number(p.poids) || 0), 0)
    + fini.reduce((s, p) => s + (Number(p.poids) || 0), 0)
  const totalMetrage = fini.reduce((s, p) => s + (Number(p.metrage) || 0), 0)
  const colSpan = DONATION_COLS.length

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-shrink-0 flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Gift className="h-3.5 w-3.5 text-accent" />
            Pièces en donation
          </div>
          {isEditing && !locked && !pendingSave && nb > 0 && (
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter / Modifier
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : nb === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Gift className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm">Aucune pièce en donation</p>
            {isEditing && !locked && (
              pendingSave ? (
                <p className="text-xs italic mt-3">Enregistrez la commande pour pouvoir ajouter des pièces.</p>
              ) : (
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setPickerOpen(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter des pièces
                </Button>
              )
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                {DONATION_COLS.map((c) => <col key={c.label} style={{ width: c.width }} />)}
              </colgroup>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  {DONATION_COLS.map((c) => (
                    <th key={c.label} className={cn('px-2.5 py-2 font-semibold whitespace-nowrap', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left')}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
            </table>
            <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  {DONATION_COLS.map((c) => <col key={c.label} style={{ width: c.width }} />)}
                </colgroup>
                <tbody>
                  {ecru.length > 0 && <GroupBandRow label={`Pièces tombé de métier (${ecru.length})`} colSpan={colSpan} />}
                  {ecru.map((p) => (
                    <tr key={`e${p.id}`} className="border-b border-border/40">
                      <DonationPieceCells p={p} />
                    </tr>
                  ))}
                  {fini.length > 0 && <GroupBandRow label={`Pièces fini (${fini.length})`} colSpan={colSpan} />}
                  {fini.map((p) => (
                    <tr key={`f${p.id}`} className="border-b border-border/40">
                      <DonationPieceCells p={p} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {nb > 0 && (
          <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-sm font-medium">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Total · {nb} pièce{nb > 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-4 tabular-nums">
              {totalMetrage > 0 && <span className="text-muted-foreground">{fmtNum(totalMetrage, 1)} ml</span>}
              <span className="text-accent text-base">{fmtNum(totalPoids, 1)} kg</span>
            </div>
          </div>
        )}
      </div>

      <DonationPickerDialog
        commandeId={commandeId}
        open={pickerOpen}
        attached={data}
        onClose={() => setPickerOpen(false)}
        onApplied={() => { setPickerOpen(false); onMutationSuccess() }}
      />
    </>
  )
}

// Full-stock picker — mirrors the legacy "Donation de pièces" dialog: a
// Tombé de métier / Fini tab pair over the entire eligible stock, checkboxes
// pre-checked for pieces already attached, Valider applies the new set.
function DonationPickerDialog({
  commandeId, open, attached, onClose, onApplied,
}: {
  commandeId: number
  open: boolean
  attached: DonationPayload | undefined
  onClose: () => void
  onApplied: () => void
}) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<'ecru' | 'fini'>('ecru')
  const [search, setSearch] = useState('')
  // null = candidates for that kind not loaded yet — that kind is left untouched.
  const [selEcru, setSelEcru] = useState<Set<number> | null>(null)
  const [selFini, setSelFini] = useState<Set<number> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ecruQ = useQuery<DonationPiece[]>({
    queryKey: ['commande-client-donation-candidates', commandeId, 'ecru'],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/donation-candidates?kind=ecru`),
    enabled: open,
  })
  const finiQ = useQuery<DonationPiece[]>({
    queryKey: ['commande-client-donation-candidates', commandeId, 'fini'],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/donation-candidates?kind=fini`),
    enabled: open && kind === 'fini',
  })

  // Reset all local state when the dialog closes.
  useEffect(() => {
    if (!open) { setKind('ecru'); setSearch(''); setSelEcru(null); setSelFini(null); setError(null) }
  }, [open])
  // Hydrate each kind's selection once from the attached flags.
  useEffect(() => {
    if (open && ecruQ.data && selEcru === null) setSelEcru(new Set(ecruQ.data.filter((p) => p.attached === 1).map((p) => p.id)))
  }, [open, ecruQ.data, selEcru])
  useEffect(() => {
    if (open && finiQ.data && selFini === null) setSelFini(new Set(finiQ.data.filter((p) => p.attached === 1).map((p) => p.id)))
  }, [open, finiQ.data, selFini])

  const list = kind === 'ecru' ? ecruQ.data : finiQ.data
  const sel = kind === 'ecru' ? selEcru : selFini
  const loading = (kind === 'ecru' ? ecruQ.isLoading : finiQ.isLoading) || sel === null

  const filtered = useMemo(() => {
    const base = list ?? []
    const q = search.trim().toLowerCase()
    if (!q) return base
    return base.filter((p) =>
      [p.ref_label, p.coloris_reference, p.numero, p.lot, p.observations, p.defauts]
        .some((v) => v && v.toLowerCase().includes(q)),
    )
  }, [list, search])

  const toggle = (id: number) => {
    setError(null)
    const setter = kind === 'ecru' ? setSelEcru : setSelFini
    setter((prev) => {
      if (!prev) return prev
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Selection summary — kinds not yet visited fall back to the currently
  // attached pieces (their set is untouched by Valider).
  const ecruSelPieces = selEcru && ecruQ.data ? ecruQ.data.filter((p) => selEcru.has(p.id)) : attached?.ecru ?? []
  const finiSelPieces = selFini && finiQ.data ? finiQ.data.filter((p) => selFini.has(p.id)) : attached?.fini ?? []
  const nbSel = ecruSelPieces.length + finiSelPieces.length
  const selPoids = ecruSelPieces.reduce((s, p) => s + (Number(p.poids) || 0), 0)
    + finiSelPieces.reduce((s, p) => s + (Number(p.poids) || 0), 0)

  const applyMut = useMutation({
    mutationFn: async () => {
      const jobs: Array<{ k: 'ecru' | 'fini'; sel: Set<number>; list: DonationPiece[] }> = []
      if (selEcru && ecruQ.data) jobs.push({ k: 'ecru', sel: selEcru, list: ecruQ.data })
      if (selFini && finiQ.data) jobs.push({ k: 'fini', sel: selFini, list: finiQ.data })
      let last: DonationPayload | null = null
      for (const { k, sel: s, list: l } of jobs) {
        const attachedIds = new Set(l.filter((p) => p.attached === 1).map((p) => p.id))
        const changed = s.size !== attachedIds.size || Array.from(s).some((x) => !attachedIds.has(x))
        if (!changed) continue
        last = await apiFetch(`/commandes-client/${commandeId}/donation-pieces`, {
          method: 'PUT',
          body: JSON.stringify({ kind: k, ids: Array.from(s) }),
        })
      }
      return last
    },
    onSuccess: (payload) => {
      // The PUT returns the refreshed attached payload — hydrate directly
      // (no refetch flicker), and drop the candidates cache so the next open
      // re-reads fresh attached flags.
      if (payload) {
        queryClient.setQueryData(['commande-client-donation', commandeId], { ecru: payload.ecru, fini: payload.fini })
      }
      queryClient.removeQueries({ queryKey: ['commande-client-donation-candidates', commandeId] })
      onApplied()
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Erreur lors de l’enregistrement'),
  })

  const pickerCols = [
    { label: '', width: '4%', align: 'center' as const },
    ...DONATION_COLS.map((c) => (c.label === 'Observations' ? { ...c, width: '22%' } : c)),
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !applyMut.isPending) onClose() }}>
      <DialogContent className="max-w-6xl w-[92vw] h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-accent" />
            Pièces en donation
          </DialogTitle>
        </DialogHeader>

        <div className="mt-3 flex-shrink-0 flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-200/50">
            {([
              { key: 'ecru' as const, label: 'Tombé de métier', Icon: TmRollIcon, count: ecruQ.data?.length },
              { key: 'fini' as const, label: 'Fini', Icon: FiniRollIcon, count: finiQ.data?.length },
            ]).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setKind(t.key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
                  kind === t.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                <t.Icon className="h-3.5 w-3.5" />
                <span>{t.label}{t.count != null ? ` (${t.count})` : ''}</span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher (référence, coloris, numéro, lot, observations)"
              className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-2 flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {pickerCols.map((c, i) => <col key={`${c.label}${i}`} style={{ width: c.width }} />)}
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                {pickerCols.map((c, i) => (
                  <th key={`${c.label}${i}`} className={cn('px-2.5 py-2 font-semibold whitespace-nowrap', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left')}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
          </table>
          <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
            {loading ? (
              <div className="h-full flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Package className="h-10 w-10 mb-2 opacity-40" />
                <p className="text-sm">{search.trim() ? 'Aucune pièce ne correspond à la recherche' : 'Aucune pièce disponible en stock'}</p>
              </div>
            ) : (
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  {pickerCols.map((c, i) => <col key={`${c.label}${i}`} style={{ width: c.width }} />)}
                </colgroup>
                <tbody>
                  {filtered.map((p) => {
                    const checked = sel?.has(p.id) ?? false
                    return (
                      <tr
                        key={p.id}
                        onClick={() => toggle(p.id)}
                        className={cn('border-b border-border/40 cursor-pointer transition-colors', checked ? 'bg-accent/10' : 'hover:bg-accent/5')}
                      >
                        <td className="px-2.5 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(p.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                          />
                        </td>
                        <DonationPieceCells p={p} />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex-shrink-0 border-t border-border/60 bg-zinc-200/50 px-3 py-1.5 text-xs text-muted-foreground flex items-center justify-between tabular-nums">
            <span>Nombre de pièces : {list?.length ?? '—'}</span>
            {search.trim() && <span>{filtered.length} affichée{filtered.length > 1 ? 's' : ''}</span>}
          </div>
        </div>

        <DialogFooter className="mt-3 flex items-center gap-2">
          {error ? (
            <p className="text-xs text-destructive mr-auto">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground mr-auto tabular-nums">
              Sélection : {nbSel} pièce{nbSel > 1 ? 's' : ''} · {fmtNum(selPoids, 1)} kg
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={applyMut.isPending}>Annuler</Button>
          <Button onClick={() => applyMut.mutate()} disabled={applyMut.isPending || (selEcru === null && selFini === null)}>
            {applyMut.isPending
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
            Valider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Micro label + value stat block used on line cards — same label/value
// language as the mobile CardKV (uppercase micro label, tabular value).
function LineStat({ label, value, className, valueClass }: {
  label: string
  value: string
  className?: string
  valueClass?: string
}) {
  return (
    <div className={className}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={cn('text-xs font-semibold tabular-nums', valueClass)}>{value}</p>
    </div>
  )
}

function LineCard({
  line, isEditing, linesLocked, isDrawerOpen, onEdit, onDelete, onOpenAffectation,
}: {
  line: LigneCommande
  isEditing: boolean
  linesLocked: boolean
  isDrawerOpen: boolean
  onEdit: () => void
  onDelete: () => void
  onOpenAffectation: (lineId: number | null) => void
}) {
  const { border, iconBg, iconColor } = lineCardColors(line)
  const chip = lineTypeChip(line.type)
  // Domain icon per line type — same visual language as the sidebar nav:
  // écru → TmRollIcon, fini → FiniRollIcon, divers → Box.
  const TypeIcon = line.type === 2 ? FiniRollIcon : line.type === 3 ? Box : TmRollIcon
  const canAffect = line.type === 1 || line.type === 2
  // Divers lines carry no rolls, but they DO open a drawer — theirs ships
  // catalog articles through the expedition_divers ledger.
  const isDivers = line.type === 3
  const clickable = !isEditing && (canAffect || isDivers)
  const target = Number(line.quantite) || 0
  const pct = target > 0 ? Math.min(100, (line.affecte / target) * 100) : 0
  // Divers gauge tracks shipped-vs-ordered (there is nothing to reserve).
  const shipPct = target > 0 ? Math.min(100, (line.expedie / target) * 100) : 0
  const variations = [line.variation1_label, line.variation2_label].filter(Boolean).join(' · ')

  return (
    <div
      data-line-id={line.IDligne_commande_client}
      className={cn(
        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
        border,
        clickable && 'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
        isDrawerOpen && 'ring-1 ring-accent bg-accent/[0.06] border-accent/50',
      )}
      onClick={clickable ? () => onOpenAffectation(isDrawerOpen ? null : line.IDligne_commande_client) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', iconBg)}>
            <TypeIcon className={cn('h-3.5 w-3.5', iconColor)} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {line.ref_label || '—'}
              {line.colori_reference ? <span className="text-muted-foreground"> / {line.colori_reference}</span> : null}
              {variations ? <span className="text-muted-foreground"> · {variations}</span> : null}
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
      {/* Stat row — mirrors the PDF lines-table vocabulary (Commandé ·
          Expédié · Prix u. · Montant), expedition date pinned right with
          its urgency color. Single source for the ordered quantity. */}
      <div className="mt-2 ml-9 flex flex-wrap items-end gap-x-6 gap-y-1.5">
        <LineStat label="Commandé" value={`${fmtNum(line.quantite, 1)} ${line.unite_label}`} />
        {(canAffect || isDivers) && (
          <LineStat
            label="Expédié"
            value={`${fmtNum(line.expedie, 1)} ${line.unite_label}`}
            valueClass={target > 0 && line.expedie >= target - 0.001 ? 'text-green-600' : undefined}
          />
        )}
        {line.prix > 0 && <LineStat label="Prix u." value={`${fmtNum(line.prix, 2)} €`} />}
        {line.montant > 0 && <LineStat label="Montant" value={`${fmtNum(line.montant, 2)} €`} />}
        {line.date_livraison && (() => {
          const u = deliveryUrgency(line.date_livraison, 0)
          return (
            <LineStat
              label="Expédition"
              value={formatHfsqlDate(line.date_livraison)}
              className="ml-auto text-right"
              valueClass={u === 'late' ? 'text-red-600' : u === 'soon' ? 'text-amber-600' : undefined}
            />
          )
        })()}
      </div>
      {!!line.commentaire?.trim() && (
        <div className="flex items-start gap-1.5 mt-2 ml-9">
          <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground italic">{line.commentaire.trim()}</p>
        </div>
      )}
      {/* Affectation gauge for écru/fini lines — single row: bar left, quantities right */}
      {canAffect && (
        <div className="mt-2 ml-9 flex items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-zinc-200 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', pct >= 99.9 ? 'bg-green-500' : 'bg-accent')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
            Affecté {fmtNum(line.affecte, 1)} / {fmtNum(line.quantite, 1)} {line.unite_label}
          </span>
        </div>
      )}
      {/* Divers lines have nothing to reserve — the gauge tracks what shipped. */}
      {isDivers && (
        <div className="mt-2 ml-9 flex items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-zinc-200 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', shipPct >= 99.9 ? 'bg-green-500' : 'bg-accent')}
              style={{ width: `${shipPct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
            Expédié {fmtNum(line.expedie, 1)} / {fmtNum(line.quantite, 1)} {line.unite_label}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Affectation drawer (reserve écru/fini rolls) ────────

function AffectationDrawer({
  commandeId, ligne, clientNom, soldee = false, onClose, onSuccess,
}: {
  commandeId: number
  ligne: LigneCommande
  clientNom?: string
  /** Commande terminée (est_soldee) → the Affectation tab goes read-only:
   *  no available pool, no affect/remove/ship, no observation edits. */
  soldee?: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const queryKey = ['commande-client-pieces', commandeId, ligne.IDligne_commande_client]

  const { data, isLoading, isError } = useQuery<AffectationPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/pieces`),
  })

  const kind = data?.kind ?? (ligne.type === 1 ? 'ecru' : 'fini')

  // Batch affect (Stock disponible): tick rolls → one "Affecter (n)" button in
  // the section header links them all in a single round-trip. All-or-nothing
  // server-side, returns the refreshed payload like the per-roll mutations.
  // `lastLinkIdRef` is the anchor for Shift+click range selection (§44).
  const [linkSel, setLinkSel] = useState<Set<number>>(new Set())
  const lastLinkIdRef = useRef<number | null>(null)
  const linkBatchMut = useMutation({
    mutationFn: (stockIds: number[]) =>
      apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/pieces/${kind}/affecter`, {
        method: 'POST',
        body: JSON.stringify({ stockIds }),
      }),
    onSuccess: (payload: AffectationPayload) => {
      setLinkSel(new Set())
      lastLinkIdRef.current = null
      queryClient.setQueryData(queryKey, payload)
      // Reserving a roll to an order line takes it out of the free pool the
      // stock screens list.
      invalidateStockCaches(queryClient)
      onSuccess()
    },
  })
  const unlinkMut = useMutation({
    mutationFn: (stockId: number) => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/pieces/${kind}/${stockId}`, { method: 'DELETE' }),
    onSuccess: (payload: AffectationPayload) => { queryClient.setQueryData(queryKey, payload); invalidateStockCaches(queryClient); onSuccess() },
  })

  // Edit a roll's free-text observations. Permission-gated: the "Modifier les
  // observations" toggle in the tab strip arms the per-roll edit affordance;
  // without it the obs/defect icons are display-only.
  const canEditObs = useHasPermission('edit_observations_rouleaux')
  const [obsEditMode, setObsEditMode] = useState(false)
  const [editObsRoll, setEditObsRoll] = useState<RollLite | null>(null)
  const obsMut = useMutation({
    mutationFn: ({ stockId, observations }: { stockId: number; observations: string }) =>
      apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/pieces/${kind}/${stockId}/observations`, {
        method: 'PUT',
        body: JSON.stringify({ observations }),
      }),
    onSuccess: (payload: AffectationPayload) => {
      queryClient.setQueryData(queryKey, payload)
      setEditObsRoll(null)
    },
  })

  // Supply view: in-progress sous-traitant orders (tricotage / ennoblissement)
  // feeding this line. Only meaningful for écru/fini lines.
  const supplyEnabled = ligne.type === 1 || ligne.type === 2
  const { data: supply, isLoading: supplyLoading } = useQuery<SupplyPayload>({
    queryKey: ['commande-client-supply', commandeId, ligne.IDligne_commande_client],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/supply`),
    enabled: supplyEnabled,
  })

  const tabs: { key: SupplyTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { key: 'affectation', label: 'Affectation', icon: Package },
    ...(ligne.type === 2 ? [{ key: 'enno' as const, label: 'Ennoblissement', icon: Droplets }] : []),
    ...(supplyEnabled ? [{ key: 'trico' as const, label: 'Tricotage', icon: KnitIcon }] : []),
    ...(supplyEnabled ? [{ key: 'exped' as const, label: 'Expédition', icon: Truck }] : []),
  ]
  const [tab, setTab] = useState<SupplyTab>('affectation')
  // Ennoblissement row clicked → open the roll-affectation modal for that dyer order.
  const [ennoTarget, setEnnoTarget] = useState<SupplyEnnoRow | null>(null)
  // Tricotage row clicked → adjust this line's planning allocation on that knitting order.
  const [tricoTarget, setTricoTarget] = useState<SupplyTricoRow | null>(null)
  // "Nouvelle commande" on a location row → open the create-order modal scoped to it.
  const [createEnnoLocation, setCreateEnnoLocation] = useState<EnnoLocationRow | null>(null)
  // "Nouvelle commande" on a stock-fil location band → knit-order modal
  // scoped to that tricoteur (legacy "Commande de Tricotage Malterre" modal,
  // generalized to any knitter holding matching yarn).
  const [createTricoLocation, setCreateTricoLocation] = useState<TricoStockFilLocation | null>(null)

  // Quick-ship (legacy Affectation tab "Expédier"): select affected rolls →
  // one new expedition carrying them, then jump to the Expédition tab.
  const [shipSel, setShipSel] = useState<Set<number>>(new Set())
  const lastShipIdRef = useRef<number | null>(null)
  const [confirmShip, setConfirmShip] = useState(false)
  const shipMut = useMutation({
    mutationFn: (stockIds: number[]) =>
      apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/expedier`, {
        method: 'POST',
        body: JSON.stringify({ stockIds }),
      }),
    onSuccess: () => {
      setConfirmShip(false)
      setShipSel(new Set())
      lastShipIdRef.current = null
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['commande-client-line-expeditions', commandeId, ligne.IDligne_commande_client] })
      onSuccess()
      setTab('exped')
    },
  })

  // Tombé-de-métier (écru) of this ref available, aggregated by sous-traitant
  // location — the legacy "029 - écru disponible" panel below the orders table.
  const { data: ennoLocations, isLoading: ennoLocLoading } = useQuery<EnnoLocationsPayload>({
    queryKey: ['commande-client-enno-locations', commandeId, ligne.IDligne_commande_client],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/supply/ennoblissement/available-by-location`),
    enabled: ligne.type === 2,
  })

  // Yarn on hand usable to knit this line's écru, aggregated by location —
  // the legacy "Stock de fil disponible" panel of the Tricotage tab.
  const { data: stockFil, isLoading: stockFilLoading } = useQuery<TricoStockFilPayload>({
    queryKey: ['commande-client-trico-stockfil', commandeId, ligne.IDligne_commande_client],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/supply/tricotage/stock-fil`),
    enabled: supplyEnabled,
  })

  const linked = data?.linked ?? []
  const available = data?.available ?? []
  const dim = data?.dim ?? 'poids'
  const uniteLabel = data?.unite_label ?? ligne.unite_label
  const target = data?.target_qty ?? (Number(ligne.quantite) || 0)
  // Combined affecté (rolls + écru at the dyer × rendement + tricotage
  // allocations) — the legacy "854 / 800 Ml" gauge, computed server-side.
  const reserved = data?.affecte_total ?? linked.reduce((s, r) => s + (dim === 'metrage' ? (Number(r.metrage) || 0) : (Number(r.poids) || 0)), 0)
  // Sum of the listed affected rolls only (unlike `reserved`, which also
  // counts écru at the dyer and tricotage allocations) — shown in the
  // section heading so it always matches the rows below.
  const linkedQty = linked.reduce((s, r) => s + (dim === 'metrage' ? (Number(r.metrage) || 0) : (Number(r.poids) || 0)), 0)

  // Shippable = affected rolls not already on an expedition. The selection is
  // re-filtered against the live payload so a refetch can't leave stale ids.
  const shippable = linked.filter((r) => !r.expedie)
  const shipSelected = shippable.filter((r) => shipSel.has(r.id))
  const shipQty = shipSelected.reduce((s, r) => s + (dim === 'metrage' ? (Number(r.metrage) || 0) : (Number(r.poids) || 0)), 0)
  // The two selections are mutually exclusive: ticking a roll in one list
  // clears the other list's selection (and its anchor), so the action bar
  // below always maps to exactly one action (Expédier vs Affecter).
  // Shift+click extends from the anchor over the rendered order (§44).
  const toggleShip = (id: number, shiftKey = false) => {
    setLinkSel(new Set())
    lastLinkIdRef.current = null
    const ids = shippable.map((r) => r.id)
    const anchor = lastShipIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setShipSel((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id) // clicked end already selected → clear the range
          for (let i = lo; i <= hi; i++) {
            if (deselect) next.delete(ids[i]); else next.add(ids[i])
          }
          return next
        })
        return
      }
    }
    setShipSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    lastShipIdRef.current = id
  }

  // Batch-affect selection, re-filtered against the live available pool so a
  // refetch can't leave stale ids (same discipline as shipSelected above).
  const linkSelected = available.filter((r) => linkSel.has(r.id))
  const linkQty = linkSelected.reduce((s, r) => s + (dim === 'metrage' ? (Number(r.metrage) || 0) : (Number(r.poids) || 0)), 0)
  const toggleLink = (id: number, shiftKey = false) => {
    setShipSel(new Set())
    lastShipIdRef.current = null
    const ids = available.map((r) => r.id)
    const anchor = lastLinkIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setLinkSel((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id) // clicked end already selected → clear the range
          for (let i = lo; i <= hi; i++) {
            if (deselect) next.delete(ids[i]); else next.add(ids[i])
          }
          return next
        })
        return
      }
    }
    setLinkSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    lastLinkIdRef.current = id
  }

  // Which list currently drives the action bar (mutual exclusion guarantees
  // at most one is non-empty).
  const selMode: 'ship' | 'link' | null =
    linkSelected.length > 0 ? 'link' : shipSelected.length > 0 ? 'ship' : null
  const selRolls = selMode === 'link' ? linkSelected : shipSelected
  const selQty = selMode === 'link' ? linkQty : shipQty
  const selAllCount = selMode === 'link' ? available.length : shippable.length
  const selBusy = shipMut.isPending || linkBatchMut.isPending

  // Obs edit toggle rides the first section heading row of the Affectation
  // tab (title left, action right — §23 header pattern) instead of claiming
  // its own band. -my-1 keeps the taller button from inflating the row.
  const obsToggle = canEditObs && !soldee ? (
    <button
      type="button"
      onClick={() => setObsEditMode((v) => !v)}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 -my-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer',
        obsEditMode
          ? 'bg-accent text-accent-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
      )}
    >
      <Pencil className="h-3 w-3" />
      <span>Modifier les observations</span>
    </button>
  ) : null

  return (
    <>
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
      {/* Tab strip + close (mps_designer §31.4) */}
      <div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t.label}</span>
            </button>
          )
        })}
        <div className="ml-auto flex items-center pr-1">
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {tab === 'affectation' && (
        <>
          <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
            {soldee && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/60 bg-zinc-200/40 text-[11px] text-muted-foreground">
                <Lock className="h-3.5 w-3.5 flex-shrink-0" />
                Commande terminée — affectation en lecture seule.
              </div>
            )}
            {isLoading && (
              <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />)}</div>
            )}
            {isError && (
              <div className="flex flex-col items-center justify-center py-6 text-destructive">
                <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
              </div>
            )}
            {!isLoading && !isError && linked.length === 0 && (soldee || available.length === 0) && (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Package className="h-8 w-8 mb-2 opacity-50" />
                <p className="text-sm font-medium">{soldee ? 'Aucun rouleau affecté' : 'Aucun rouleau en stock'}</p>
                {!soldee && <p className="text-xs mt-1">Aucun rouleau correspondant à cette référence n'est disponible.</p>}
              </div>
            )}

            {linked.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                    Affecté à la commande ({linked.length} · {fmtNum(linkedQty, 1)} {dim === 'metrage' ? 'Ml' : 'kg'})
                  </h3>
                  {obsToggle}
                </div>
                <div className="space-y-1.5">
                  {linked.map((roll) => (
                    <RollRow key={roll.id} roll={roll} dim={dim} action="unlink"
                      kind={kind === 'fini' ? 'fini' : 'ecru'}
                      readOnly={soldee}
                      onEditObs={soldee || !obsEditMode ? undefined : () => setEditObsRoll(roll)}
                      onAction={() => unlinkMut.mutate(roll.id)}
                      isBusy={unlinkMut.isPending && unlinkMut.variables === roll.id}
                      selected={!soldee && !roll.expedie && shipSel.has(roll.id)}
                      onToggleSelect={soldee || roll.expedie ? undefined : (shiftKey) => toggleShip(roll.id, shiftKey)} />
                  ))}
                </div>
              </section>
            )}

            {/* Terminée → the available pool disappears: nothing can be
                affected anymore, the tab is a record of what shipped. */}
            {!soldee && available.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                    Stock disponible ({available.length})
                  </h3>
                  {linked.length === 0 ? obsToggle : null}
                </div>
                <div className="space-y-1.5">
                  {available.map((roll) => (
                    <RollRow key={roll.id} roll={roll} dim={dim}
                      kind={kind === 'fini' ? 'fini' : 'ecru'}
                      onEditObs={obsEditMode ? () => setEditObsRoll(roll) : undefined}
                      selected={linkSel.has(roll.id)}
                      onToggleSelect={(shiftKey) => toggleLink(roll.id, shiftKey)} />
                  ))}
                </div>
              </section>
            )}

            {!soldee && !isLoading && !isError && linked.length > 0 && available.length === 0 && (
              <p className="text-xs text-muted-foreground italic text-center">Aucun rouleau supplémentaire disponible.</p>
            )}
          </div>

          {/* Selection action bar — appears as soon as rolls are ticked in
              either list. Affecté selection → Expédier (legacy quick-ship);
              Stock disponible selection → Affecter. Mutual exclusion above
              guarantees the bar maps to exactly one action. */}
          {!soldee && selMode !== null && (
            <div className="flex-shrink-0 px-3 py-2 border-t bg-zinc-200/50 flex items-center gap-2">
              <div className="flex items-center gap-1">
                <button type="button"
                  onClick={() => {
                    if (selMode === 'link') {
                      setLinkSel(new Set(available.map((r) => r.id)))
                      lastLinkIdRef.current = available[available.length - 1]?.id ?? null
                    } else {
                      setShipSel(new Set(shippable.map((r) => r.id)))
                      lastShipIdRef.current = shippable[shippable.length - 1]?.id ?? null
                    }
                  }}
                  disabled={selBusy || selRolls.length === selAllCount}
                  className="text-[11px] text-accent hover:underline disabled:text-muted-foreground/50 disabled:no-underline disabled:cursor-default px-1">Tout</button>
                <span className="text-muted-foreground/40 text-[11px]">·</span>
                <button type="button" onClick={() => {
                  setLinkSel(new Set()); setShipSel(new Set())
                  lastLinkIdRef.current = null; lastShipIdRef.current = null
                }}
                  disabled={selBusy}
                  className="text-[11px] text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:cursor-default px-1">Aucun</button>
              </div>
              <p className="text-[11px] text-muted-foreground tabular-nums ml-auto whitespace-nowrap">
                {selRolls.length} rouleau{selRolls.length > 1 ? 'x' : ''} · {fmtNum(selQty, 1)} {uniteLabel}
              </p>
              {selMode === 'link' ? (
                <Button size="sm" onClick={() => linkBatchMut.mutate(linkSelected.map((r) => r.id))}
                  disabled={linkBatchMut.isPending} className="flex-shrink-0">
                  {linkBatchMut.isPending
                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
                  Affecter
                </Button>
              ) : (
                <Button size="sm" onClick={() => setConfirmShip(true)} disabled={shipMut.isPending} className="flex-shrink-0">
                  {shipMut.isPending
                    ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    : <Truck className="h-3.5 w-3.5 mr-1.5" />}
                  Expédier
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'enno' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              Commandes ennoblisseur en cours
            </h3>
            <SupplyTable
              loading={supplyLoading}
              rows={supply?.ennoblissement ?? []}
              emptyLabel="Aucune commande ennoblisseur en cours"
              emptyIcon={Droplets}
              onRowClick={setEnnoTarget}
              columns={[
                { key: 'no', label: 'N°', align: 'left', render: (r) => <span className="tabular-nums font-medium">{r.commande_id}</span> },
                { key: 'dc', label: 'Date', align: 'left', render: (r) => fmtSupplyDate(r.date_commande) },
                { key: 'sst', label: 'Ennoblisseur', align: 'left', render: (r) => r.sous_traitant_nom || '—' },
                { key: 'dl', label: 'Délai', align: 'left', render: (r) => fmtSupplyDate(r.date_livraison) },
                { key: 'et', label: 'État', align: 'left', render: (r) => <SupplyEtatPill label={r.etat_label} /> },
                { key: 'di', label: 'Disponible', align: 'right', render: (r) => <span className="font-semibold">{fmtNum(r.qte_disponible, 1)} Ml</span> },
                { key: 'af', label: 'Affecté', align: 'right', render: (r) => <span className="font-semibold">{fmtNum(r.qte_affecte, 1)} Ml</span> },
              ]}
            />
          </section>

          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              {ennoLocations?.ecru_ref_label
                ? `${ennoLocations.ecru_ref_label}${ennoLocations.ecru_coloris_label ? ` /${ennoLocations.ecru_coloris_label}` : ''} — tombé de métier disponible`
                : 'Tombé de métier disponible'}
            </h3>
            <EnnoLocationTable
              loading={ennoLocLoading}
              locations={ennoLocations?.locations ?? []}
              onNewOrder={setCreateEnnoLocation}
            />
          </section>
        </div>
      )}

      {tab === 'trico' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              Commandes tricoteur en cours
            </h3>
            <SupplyTable
              loading={supplyLoading}
              rows={supply?.tricotage ?? []}
              emptyLabel="Aucune commande tricotage en cours"
              emptyIcon={KnitIcon}
              onRowClick={setTricoTarget}
              columns={[
                { key: 'no', label: 'N°', align: 'left', render: (r) => <span className="tabular-nums font-medium">{r.commande_id}</span> },
                { key: 'dc', label: 'Date', align: 'left', render: (r) => fmtSupplyDate(r.date_commande) },
                { key: 'sst', label: 'Tricoteur', align: 'left', render: (r) => r.sous_traitant_nom || '—' },
                { key: 'dl', label: 'Délai', align: 'left', render: (r) => fmtSupplyDate(r.date_livraison) },
                { key: 'di', label: 'Poids dispo.', align: 'right', render: (r) => `${fmtNum(r.poids_disponible, 1)} Kg` },
                { key: 'af', label: 'Poids affecté', align: 'right', render: (r) => `${fmtNum(r.poids_affecte, 1)} Kg` },
                { key: 'mp', label: 'Métrage pot.', align: 'right', render: (r) => <span className="font-semibold">{fmtNum(r.metrage_potentiel, 0)} Ml</span> },
              ]}
            />
          </section>

          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              {stockFil?.ecru_ref_label
                ? `${stockFil.ecru_ref_label} — stock de fil disponible`
                : 'Stock de fil disponible'}
            </h3>
            <StockFilDispoTable
              loading={stockFilLoading}
              locations={stockFil?.locations ?? []}
              onNewOrder={setCreateTricoLocation}
            />
          </section>
        </div>
      )}

      {tab === 'exped' && (
        <ExpeditionTab
          commandeId={commandeId}
          ligneId={ligne.IDligne_commande_client}
          kind={kind === 'fini' ? 'fini' : 'ecru'}
        />
      )}
    </div>
    {editObsRoll && (kind === 'ecru' || kind === 'fini') && (
      <EditRollObsDialog
        roll={editObsRoll}
        kind={kind}
        isPending={obsMut.isPending}
        onCancel={() => setEditObsRoll(null)}
        onSave={(observations) => obsMut.mutate({ stockId: editObsRoll.id, observations })}
      />
    )}
    {ennoTarget && (
      <EnnoblissementAffectationDialog
        commandeId={commandeId}
        ligneId={ligne.IDligne_commande_client}
        row={ennoTarget}
        onClose={() => setEnnoTarget(null)}
        onSuccess={onSuccess}
      />
    )}
    {tricoTarget && (
      <TricotageAffectationDialog
        commandeId={commandeId}
        ligneId={ligne.IDligne_commande_client}
        row={tricoTarget}
        clientNom={clientNom}
        reserved={reserved}
        target={target}
        dim={dim}
        uniteLabel={uniteLabel}
        rendement={stockFil?.rendement ?? 0}
        refLabel={ligne.ref_label}
        onClose={() => setTricoTarget(null)}
        onSuccess={() => {
          // The allocation feeds the supply table AND the line's combined
          // affecté gauge (pieces payload).
          queryClient.invalidateQueries({ queryKey: ['commande-client-supply', commandeId, ligne.IDligne_commande_client] })
          queryClient.invalidateQueries({ queryKey })
          onSuccess()
        }}
      />
    )}
    {createEnnoLocation && (
      <CreateEnnoblisseurOrderDialog
        commandeId={commandeId}
        ligne={ligne}
        location={createEnnoLocation}
        clientNom={clientNom}
        reserved={reserved}
        target={target}
        dim={dim}
        uniteLabel={uniteLabel}
        onClose={() => setCreateEnnoLocation(null)}
        onSuccess={() => {
          // Refresh the orders table + the affectation panel (new affected
          // rolls) + the location pool, plus the parent line list.
          queryClient.invalidateQueries({ queryKey: ['commande-client-supply', commandeId, ligne.IDligne_commande_client] })
          queryClient.invalidateQueries({ queryKey })
          queryClient.invalidateQueries({ queryKey: ['commande-client-enno-locations', commandeId, ligne.IDligne_commande_client] })
          onSuccess()
        }}
      />
    )}
    <ConfirmDialog
      open={confirmShip}
      variant="default"
      title="Expédier les rouleaux"
      description={`Créer une expédition avec ${shipSelected.length} rouleau${shipSelected.length > 1 ? 'x' : ''} (${fmtNum(shipQty, 1)} ${uniteLabel}) pour cette commande ?`}
      confirmLabel="Expédier"
      isPending={shipMut.isPending}
      onCancel={() => setConfirmShip(false)}
      onConfirm={() => shipMut.mutate(shipSelected.map((r) => r.id))}
    />
    {createTricoLocation && (
      <CreateTricotageOrderDialog
        commandeId={commandeId}
        ligne={ligne}
        location={createTricoLocation}
        clientNom={clientNom}
        reserved={reserved}
        target={target}
        dim={dim}
        uniteLabel={uniteLabel}
        onClose={() => setCreateTricoLocation(null)}
        onSuccess={() => {
          // New knit order + its allocation land in the supply table; the yarn
          // reservations change the stock-fil panel too.
          queryClient.invalidateQueries({ queryKey: ['commande-client-supply', commandeId, ligne.IDligne_commande_client] })
          queryClient.invalidateQueries({ queryKey: ['commande-client-trico-stockfil', commandeId, ligne.IDligne_commande_client] })
          onSuccess()
        }}
      />
    )}
    </>
  )
}

type SupplyTab = 'affectation' | 'enno' | 'trico' | 'exped'

function fmtSupplyDate(d: string | null): string {
  return d && d.length === 8 && d !== '00000000' ? formatHfsqlDate(d) : '—'
}

// Compact table for the supply tabs (ennoblissement / tricotage). Generic over
// the row shape; columns describe their own rendering + alignment.
function SupplyTable<T extends { id: number }>({
  loading, rows, columns, emptyLabel, emptyIcon: EmptyIcon, onRowClick, selectedId,
}: {
  loading: boolean
  rows: T[]
  columns: { key: string; label: string; align: 'left' | 'right'; render: (r: T) => ReactNode }[]
  emptyLabel: string
  emptyIcon: ComponentType<{ className?: string }>
  onRowClick?: (r: T) => void
  selectedId?: number | null
}) {
  if (loading) {
    return <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded-md" />)}</div>
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <EmptyIcon className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-zinc-200/60 border-b border-border/60">
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {columns.map((c) => (
              <th key={c.key} className={cn('px-2.5 py-2 font-semibold whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn(
                'border-b border-border/40 last:border-0',
                onRowClick ? 'cursor-pointer hover:bg-accent/10' : 'hover:bg-accent/5',
                selectedId === r.id && 'bg-accent/10',
              )}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-2.5 py-2 whitespace-nowrap', c.align === 'right' ? 'text-right tabular-nums' : 'text-left')}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RollRow({
  roll, dim, action, onAction, isBusy, kind = 'ecru', onEditObs, selected, onToggleSelect, readOnly = false,
}: {
  roll: RollLite
  dim: 'metrage' | 'poids'
  /** Per-row action button. Omit action/onAction for checkbox-only rows
   *  (batch selection lists — the batch button lives in the section header). */
  action?: 'link' | 'unlink'
  onAction?: () => void
  isBusy?: boolean
  /** Drives the domain icon: fini → green FiniRollIcon, écru → TmRollIcon
   *  (mirrors the sous-traitant commande pieces drawer). */
  kind?: 'ecru' | 'fini'
  /** When set, a pencil opens the observations edit dialog for this roll. */
  onEditObs?: () => void
  /** Batch selection (Affectation tab): when onToggleSelect is set the row
   *  shows a checkbox and highlights when selected. `shiftKey` is forwarded
   *  so the caller can implement Shift+click range selection (§44). */
  selected?: boolean
  onToggleSelect?: (shiftKey: boolean) => void
  /** Commande terminée: display only — no action button. */
  readOnly?: boolean
}) {
  const primary = dim === 'metrage' ? Number(roll.metrage) || 0 : Number(roll.poids) || 0
  const primaryLabel = dim === 'metrage' ? 'Ml' : 'kg'
  const secondary = dim === 'metrage' ? Number(roll.poids) || 0 : Number(roll.metrage) || 0
  const secondaryLabel = dim === 'metrage' ? 'kg' : 'Ml'
  // Notes surface as hover icons on the right of the card (tooltip carries
  // the text) instead of full-width banners — keeps the roll list compact.
  const obsText = roll.observations?.trim() ?? ''
  const defautText = (roll.observation_sst ?? '').trim()
  const isSecondChoix = Number(roll.second_choix) > 0
  const hasDefect = isSecondChoix || defautText.length > 0
  return (
    <div
      // When the row is selectable, the whole card is the click target —
      // inner action buttons stop propagation so they don't also toggle.
      onClick={onToggleSelect ? (e) => onToggleSelect(e.shiftKey) : undefined}
      className={cn(
        'rounded-lg border border-border/60 bg-card shadow-sm p-3',
        // select-none: Shift+click must extend the selection, not highlight text.
        onToggleSelect && 'cursor-pointer select-none hover:border-accent/40 transition-colors',
        selected && 'border-accent ring-1 ring-accent bg-accent/[0.06]',
      )}
    >
      <div className="flex items-center gap-3">
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect(e.shiftKey) }}
            title={selected ? 'Retirer de la sélection' : 'Sélectionner'}
            className={cn(
              'h-5 w-5 rounded flex items-center justify-center flex-shrink-0 border transition-colors',
              selected ? 'bg-accent border-accent text-accent-foreground' : 'border-input bg-background hover:border-accent/60',
            )}
          >
            {selected && <CheckCircle2 className="h-3.5 w-3.5" />}
          </button>
        )}
        <div className={cn(
          'h-10 w-10 rounded-md flex items-center justify-center flex-shrink-0',
          kind === 'fini' ? 'bg-green-500/10' : 'bg-zinc-100',
        )}>
          {kind === 'fini'
            ? <FiniRollIcon className="h-7 w-7 text-green-600" />
            : <TmRollIcon className="h-7 w-7 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">{roll.numero || `Rouleau ${roll.id}`}</span>
            {roll.lot && <span className="text-xs text-muted-foreground truncate">· Lot {roll.lot}</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">{fmtNum(primary, 1)} {primaryLabel}</span>
            {secondary > 0 && <span>· {fmtNum(secondary, 1)} {secondaryLabel}</span>}
            {/* No coloris here — every roll in the drawer already matches the
                line's coloris, so repeating it per row is pure noise. */}
            {roll.magasin_nom && <span className="flex items-center gap-0.5 truncate"><MapPin className="h-2.5 w-2.5" />{roll.magasin_nom}</span>}
          </div>
        </div>
        {hasDefect && (
          <Tooltip
            side="left"
            content={
              <div className="w-max max-w-[320px] space-y-1.5 py-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-700 whitespace-nowrap">
                  Défauts
                </p>
                {isSecondChoix && (
                  <p className="text-xs font-bold uppercase tracking-wide text-red-700">2e choix</p>
                )}
                {defautText.length > 0 && (
                  <p className="text-sm font-normal whitespace-pre-line">{defautText}</p>
                )}
              </div>
            }
          >
            <span
              className="h-6 w-6 rounded-md flex items-center justify-center flex-shrink-0 cursor-pointer border border-red-200 bg-red-50 hover:bg-red-100 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
            </span>
          </Tooltip>
        )}
        {/* Observations: single affordance replacing the old pencil — gray
            ghost when empty (click to add), blue framed when filled (hover
            shows the text, click edits). */}
        {obsText.length > 0 ? (
          <Tooltip
            side="left"
            content={
              <div className="w-max max-w-[320px] space-y-1.5 py-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 whitespace-nowrap">
                  Observations
                </p>
                <p className="text-sm font-normal whitespace-pre-line">{obsText}</p>
              </div>
            }
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEditObs?.() }}
              className={cn(
                'h-6 w-6 rounded-md flex items-center justify-center flex-shrink-0 border border-blue-200 bg-blue-50 transition-colors',
                onEditObs ? 'cursor-pointer hover:bg-blue-100' : 'cursor-default',
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 text-blue-600" />
            </button>
          </Tooltip>
        ) : onEditObs ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEditObs() }}
            className="h-6 w-6 rounded-md flex items-center justify-center flex-shrink-0 text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {/* A shipped roll's affectation is locked (the expedition owns it) —
            no "Retirer"; the état pill already says why. Read-only mode
            (commande terminée) hides the action entirely. */}
        {!readOnly && action && onAction && !(action === 'unlink' && roll.expedie) && (
          <Button size="sm" variant={action === 'link' ? 'default' : 'outline'} onClick={(e) => { e.stopPropagation(); onAction() }} disabled={isBusy} className="flex-shrink-0">
            {isBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : action === 'link' ? <Link2 className="h-3.5 w-3.5 mr-1.5" /> : <Unlink className="h-3.5 w-3.5 mr-1.5" />}
            {action === 'link' ? 'Affecter' : 'Retirer'}
          </Button>
        )}
        {/* État pill anchored at the far right — the one element present on
            every row, so it lands on the same spot regardless of which icons
            or buttons happen to render on its left (mps_designer §37). */}
        <EtatPill libelle={roll.etat_label} variant="solid" className="flex-shrink-0" />
      </div>
    </div>
  )
}

// ── Expédition tab (legacy "Gestion ligne de commande" Expédition) ──
// Expeditions carrying this line's rolls; clicking one shows its rolls and
// the shipment info (transporteur, adresse, état).

interface LineExpeditionRoll {
  id: number
  numero: string | null
  lot: string | null
  poids: number
  metrage: number
  magasin_nom: string | null
}
interface LineExpedition {
  IDexpedition: number
  date: string | null
  est_valide: number
  est_facture: number
  inclure_rapport: number
  transporteur_nom: string
  adresse_nom: string
  adresse_ville: string
  nb_rolls: number
  poids: number
  metrage: number
  rolls: LineExpeditionRoll[]
}
interface LineExpeditionsPayload {
  dim: 'metrage' | 'poids'
  unite_label: string
  expeditions: LineExpedition[]
}

function ExpeditionTab({
  commandeId, ligneId, kind,
}: {
  commandeId: number
  ligneId: number
  kind: 'ecru' | 'fini'
}) {
  const { data, isLoading } = useQuery<LineExpeditionsPayload>({
    queryKey: ['commande-client-line-expeditions', commandeId, ligneId],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/expeditions`),
  })
  const exps = useMemo(() => data?.expeditions ?? [], [data])
  const dim = data?.dim ?? 'metrage'
  const [selId, setSelId] = useState<number | null>(null)
  // Per-row print/email — same endpoints and flow as Clients › Expéditions
  // (line expeditions are always formal ones, hence the fixed bucket).
  const [emailExpId, setEmailExpId] = useState<number | null>(null)
  const sel = exps.find((e) => e.IDexpedition === selId) ?? exps[0] ?? null
  const RollIcon = kind === 'fini' ? FiniRollIcon : TmRollIcon

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
      <section>
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
          Expéditions de la ligne
        </h3>
        <SupplyTable
          loading={isLoading}
          rows={exps.map((e) => ({ ...e, id: e.IDexpedition }))}
          emptyLabel="Aucune expédition pour cette ligne"
          emptyIcon={Truck}
          onRowClick={(r) => setSelId(r.IDexpedition)}
          selectedId={sel?.IDexpedition ?? null}
          columns={[
            { key: 'no', label: 'N°', align: 'left', render: (r) => <span className="tabular-nums font-medium">{r.IDexpedition}</span> },
            { key: 'dt', label: 'Date', align: 'left', render: (r) => fmtSupplyDate(r.date) },
            { key: 'tr', label: 'Transporteur', align: 'left', render: (r) => r.transporteur_nom || '—' },
            {
              key: 'et', label: 'État', align: 'left', render: (r) => (
                r.est_facture
                  ? <Badge variant="outline" className="text-[10px] py-0 gap-1 border text-white bg-success border-success">Facturée</Badge>
                  : <Badge variant="outline" className="text-[10px] py-0 gap-1 border text-white bg-primary border-primary">Non facturée</Badge>
              ),
            },
            { key: 'nb', label: 'Rouleaux', align: 'right', render: (r) => <span>{r.nb_rolls}</span> },
            {
              key: 'q', label: dim === 'metrage' ? 'Métrage' : 'Poids', align: 'right',
              render: (r) => <span className="font-semibold">{dim === 'metrage' ? `${fmtNum(r.metrage, 1)} Ml` : `${fmtNum(r.poids, 1)} kg`}</span>,
            },
            {
              key: 'actions', label: '', align: 'right',
              render: (r) => (
                <span className="inline-flex items-center gap-0.5">
                  <Button
                    variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-accent hover:bg-accent/10"
                    title="Imprimer"
                    onClick={(e) => { e.stopPropagation(); window.open(`${API_URL}/expeditions/formelle/${r.IDexpedition}/pdf`, '_blank') }}
                  >
                    <Printer className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-accent hover:bg-accent/10"
                    title="Envoyer un email"
                    onClick={(e) => { e.stopPropagation(); setEmailExpId(r.IDexpedition) }}
                  >
                    <AtSign className="h-3.5 w-3.5" />
                  </Button>
                  {/* Fiche de transport — internal pickup request for the carrier. */}
                  <Button
                    variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-accent hover:bg-accent/10"
                    title="Imprimer la demande de transport"
                    onClick={(e) => { e.stopPropagation(); window.open(`${API_URL}/expeditions/formelle/${r.IDexpedition}/demande-transport/pdf`, '_blank') }}
                  >
                    <Truck className="h-3.5 w-3.5" />
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </section>

      {emailExpId !== null && (
        <SendEmailDialog
          open
          onClose={() => setEmailExpId(null)}
          contextLabel={`Expédition N° ${emailExpId}`}
          queryKey={['expedition-email-defaults', 'formelle', emailExpId]}
          loadDefaults={() => apiFetch(`/expeditions/formelle/${emailExpId}/email-defaults`)}
          pdfUrl={`${API_URL}/expeditions/formelle/${emailExpId}/pdf`}
          pdfAttachmentLabel={`BL-${emailExpId}.pdf`}
          optionalServerAttachments={[
            { id: 'rapport-controle', label: `RC-${emailExpId}.pdf`, url: `${API_URL}/expeditions/formelle/${emailExpId}/rapport-controle/pdf`, defaultChecked: false },
            { id: 'info-matieres', label: `Info-matieres-${emailExpId}.pdf`, url: `${API_URL}/expeditions/formelle/${emailExpId}/info-matieres/pdf`, defaultChecked: false },
          ]}
          onSend={(p) => postEmail(`${API_URL}/expeditions/formelle/${emailExpId}/email`, p, {
            includeAttachPdf: true,
            extraBody: {
              attach_rapport_controle: p.optionalAttachments?.['rapport-controle'] ?? false,
              attach_info_matieres: p.optionalAttachments?.['info-matieres'] ?? false,
            },
          })}
        />
      )}

      {sel && (
        <section>
          <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2.5 py-2 font-semibold text-left w-full">Numéro</th>
                  <th className="px-2.5 py-2 font-semibold text-left">Lot</th>
                  <th className="px-2.5 py-2 font-semibold text-right">Métrage</th>
                  <th className="px-2.5 py-2 font-semibold text-right">Poids</th>
                  <th className="px-2.5 py-2 font-semibold text-left">Magasin</th>
                </tr>
              </thead>
              <tbody>
                {sel.rolls.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <RollIcon className={cn('h-4 w-4 flex-shrink-0', kind === 'fini' ? 'text-green-600' : 'text-muted-foreground')} />
                        {r.numero || `#${r.id}`}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap tabular-nums">{r.lot || '—'}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums">{r.metrage > 0 ? `${fmtNum(r.metrage, 1)} Ml` : '—'}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums">{r.poids > 0 ? `${fmtNum(r.poids, 1)} kg` : '—'}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap truncate max-w-[140px]">{r.magasin_nom || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

// ── Divers lines: shipment drawer + grouped shipment modal ──
// A divers (type 3) line names a catalog article (ref_divers + up to two
// variation axes) instead of stock rolls. It ships through expedition_divers:
//   expédition (header, back-pointing at the commande)
//     └ carton (ligne_expedition_divers)
//         └ article (ref_divers_expedie) — ref + variations + quantity
// The drawer below is the per-line view (legacy Commandes › Expédition tab);
// ExpeditionGroupeeDialog is the whole-order editor (legacy Expéditions
// Groupées modal).

interface DiversShipItem {
  IDref_divers_expedie: number
  IDref_divers: number
  ref_designation: string
  designation: string
  IDVariation1: number
  variation1_label: string | null
  IDVariation2: number
  variation2_label: string | null
  quantite: number
  unite: number
  unite_label: string
  prix: number
}
interface DiversShipCarton {
  IDligne_expedition_divers: number
  detail_ligne: string
  items: DiversShipItem[]
}
interface DiversShipExpedition {
  IDexpedition_divers: number
  date: string | null
  ref_client: string | null
  est_valide: number
  est_facture: number
  /** Facturée → the shipment and all its cartons are read-only. */
  locked: number
  IDtransporteur: number
  transporteur_nom: string
  IDadresse: number
  adresse_nom: string
  adresse_ville: string
  cartons: DiversShipCarton[]
}
interface DiversLinePayload {
  IDligne_commande_client: number
  IDref_divers: number
  ref_designation: string
  IDVariation1: number
  variation1_label: string | null
  IDVariation2: number
  variation2_label: string | null
  unite: number
  unite_label: string
  prix: number
  quantite_commandee: number
  quantite_expediee: number
  /** stock_divers on-hand for this exact article; null = no ledger row. */
  stock_disponible: number | null
  expeditions: DiversShipExpedition[]
}

/** Label for a shipped article: its own designation when set, else the catalog
 *  designation, narrowed by whichever variation axes it carries. */
function diversArticleLabel(
  ref: string, v1: string | null | undefined, v2: string | null | undefined,
): string {
  const variations = [v1, v2].filter(Boolean).join(' · ')
  return variations ? `${ref || '—'} · ${variations}` : (ref || '—')
}

function DiversLineDrawer({
  commandeId, ligne, soldee = false, onClose, onSuccess,
}: {
  commandeId: number
  ligne: LigneCommande
  /** Commande terminée → the drawer is a read-only record of what shipped. */
  soldee?: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const queryKey = ['commande-client-divers-line', commandeId, ligne.IDligne_commande_client]

  const { data, isLoading, isError } = useQuery<DiversLinePayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/divers`),
  })

  const [qty, setQty] = useState('')
  const [qtyTouched, setQtyTouched] = useState(false)
  const [confirmShip, setConfirmShip] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailExpId, setEmailExpId] = useState<number | null>(null)

  const uniteLabel = data?.unite_label ?? ligne.unite_label
  const commandee = data?.quantite_commandee ?? (Number(ligne.quantite) || 0)
  const expediee = data?.quantite_expediee ?? (Number(ligne.expedie) || 0)
  const reste = Math.max(0, Math.round((commandee - expediee) * 100) / 100)
  const stock = data?.stock_disponible ?? null

  // Prefill with what's left to ship, capped by what's actually on hand —
  // the legacy "Quelle quantité voulez-vous expédier" default. Stops
  // prefilling once the user types, so a refetch can't clobber their input.
  useEffect(() => {
    if (!data || qtyTouched) return
    const suggested = stock != null && stock > 0 ? Math.min(reste, stock) : reste
    setQty(suggested > 0 ? String(suggested) : '')
  }, [data, qtyTouched, reste, stock])

  const shipMut = useMutation({
    mutationFn: (quantite: number) =>
      apiFetch(`/commandes-client/${commandeId}/lignes/${ligne.IDligne_commande_client}/expedier-divers`, {
        method: 'POST',
        body: JSON.stringify({ quantite }),
      }),
    onSuccess: () => {
      setConfirmShip(false)
      setQtyTouched(false)
      setError(null)
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['commande-client-divers-expeditions', commandeId] })
      onSuccess()
    },
    onError: (e: unknown) => {
      setConfirmShip(false)
      setError(e instanceof Error ? e.message : 'Erreur')
    },
  })

  const qtyNum = Number(qty.replace(',', '.'))
  const canShip = !soldee && Number.isFinite(qtyNum) && qtyNum > 0

  return (
    <>
      <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
        {/* Tab strip + close (mps_designer §31.4) — single tab, the drawer has
            one job: ship this article and show where it already went. */}
        <div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
            <Truck className="h-3.5 w-3.5" />
            <span>Expédition</span>
          </span>
          <div className="ml-auto flex items-center pr-1">
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
          {soldee && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/60 bg-zinc-200/40 text-[11px] text-muted-foreground">
              <Lock className="h-3.5 w-3.5 flex-shrink-0" />
              Commande terminée — expédition en lecture seule.
            </div>
          )}
          {isLoading && (
            <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />)}</div>
          )}
          {isError && (
            <div className="flex flex-col items-center justify-center py-6 text-destructive">
              <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
            </div>
          )}

          {data && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                Article
              </h3>
              <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-stone-400/10">
                    <Box className="h-3.5 w-3.5 text-stone-600" />
                  </div>
                  <p className="text-sm font-medium truncate">{data.ref_designation || '—'}</p>
                </div>
                <div className="ml-9 space-y-1">
                  {!!data.variation1_label && <KV label="Variation 1" value={data.variation1_label} />}
                  {!!data.variation2_label && <KV label="Variation 2" value={data.variation2_label} />}
                  <KV label="Commandé" value={`${fmtNum(commandee, 1)} ${uniteLabel}`} />
                  <KV
                    label="Expédié"
                    value={
                      <span className={cn('tabular-nums', commandee > 0 && expediee >= commandee - 0.001 && 'text-green-600 font-semibold')}>
                        {fmtNum(expediee, 1)} {uniteLabel}
                      </span>
                    }
                  />
                  <KV label="Reste à expédier" value={`${fmtNum(reste, 1)} ${uniteLabel}`} />
                  <KV
                    label="Stock disponible"
                    value={
                      stock == null
                        ? <span className="text-muted-foreground italic">non suivi</span>
                        : (
                          <span className={cn('tabular-nums font-semibold', stock <= 0 ? 'text-destructive' : stock < reste ? 'text-amber-600' : 'text-green-600')}>
                            {fmtNum(stock, 1)} {uniteLabel}
                          </span>
                        )
                    }
                  />
                  {data.prix > 0 && <KV label="Prix unitaire" value={`${fmtNum(data.prix, 2)} €`} />}
                </div>
              </div>
            </section>
          )}

          {data && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                Expéditions de la ligne
              </h3>
              {data.expeditions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Truck className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-sm font-medium">Aucune expédition pour cette ligne</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-200/60 border-b border-border/60">
                      <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-2.5 py-2 font-semibold text-left">N°</th>
                        <th className="px-2.5 py-2 font-semibold text-left">Date</th>
                        <th className="px-2.5 py-2 font-semibold text-left w-full">Conteneur</th>
                        <th className="px-2.5 py-2 font-semibold text-right">Quantité</th>
                        <th className="px-2.5 py-2 font-semibold text-left">État</th>
                        <th className="px-2.5 py-2 font-semibold text-right"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.expeditions.flatMap((e) =>
                        e.cartons.map((c, ci) => {
                          const cartonQty = c.items.reduce((s, i) => s + i.quantite, 0)
                          return (
                            <tr key={c.IDligne_expedition_divers} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                              <td className="px-2.5 py-1.5 whitespace-nowrap tabular-nums font-medium">
                                {ci === 0 ? e.IDexpedition_divers : ''}
                              </td>
                              <td className="px-2.5 py-1.5 whitespace-nowrap">{ci === 0 ? fmtSupplyDate(e.date) : ''}</td>
                              <td className="px-2.5 py-1.5 truncate">
                                <span className="inline-flex items-center gap-1.5 font-medium">
                                  <Package className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                                  {c.detail_ligne || '—'}
                                </span>
                              </td>
                              <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums font-semibold">
                                {fmtNum(cartonQty, 1)} {uniteLabel}
                              </td>
                              <td className="px-2.5 py-1.5 whitespace-nowrap">
                                {ci === 0 && (
                                  e.est_facture
                                    ? <Badge variant="outline" className="text-[10px] py-0 gap-1 border text-white bg-success border-success">Facturée</Badge>
                                    : <Badge variant="outline" className="text-[10px] py-0 gap-1 border text-white bg-primary border-primary">Non facturée</Badge>
                                )}
                              </td>
                              <td className="px-2.5 py-1.5 whitespace-nowrap text-right">
                                {ci === 0 && (
                                  <span className="inline-flex items-center gap-0.5">
                                    <Button
                                      variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-accent hover:bg-accent/10"
                                      title="Imprimer le bon de livraison"
                                      onClick={() => window.open(`${API_URL}/expeditions/divers/${e.IDexpedition_divers}/pdf`, '_blank')}
                                    >
                                      <Printer className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-accent hover:bg-accent/10"
                                      title="Envoyer un email"
                                      onClick={() => setEmailExpId(e.IDexpedition_divers)}
                                    >
                                      <AtSign className="h-3.5 w-3.5" />
                                    </Button>
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        }),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {error && (
            <div className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>

        {/* Ship bar — the legacy "Expédier" button + quantity prompt, inlined. */}
        {!soldee && data && (
          <div className="flex-shrink-0 px-3 py-2 border-t bg-zinc-200/50 flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground font-medium">Quantité à expédier</label>
            <input
              type="text"
              inputMode="decimal"
              value={qty}
              onChange={(e) => { setQty(e.target.value); setQtyTouched(true); setError(null) }}
              className="h-8 w-24 px-2 text-sm text-right tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="text-[11px] text-muted-foreground">{uniteLabel}</span>
            {stock != null && Number.isFinite(qtyNum) && qtyNum > stock && (
              <span className="text-[11px] text-amber-600 font-medium">Au-delà du stock disponible</span>
            )}
            <Button
              size="sm"
              className="ml-auto flex-shrink-0"
              disabled={!canShip || shipMut.isPending}
              onClick={() => setConfirmShip(true)}
            >
              {shipMut.isPending
                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <Truck className="h-3.5 w-3.5 mr-1.5" />}
              Expédier
            </Button>
          </div>
        )}
      </div>

      {emailExpId !== null && (
        <SendEmailDialog
          open
          onClose={() => setEmailExpId(null)}
          contextLabel={`Expédition N° ${emailExpId}`}
          queryKey={['expedition-email-defaults', 'divers', emailExpId]}
          loadDefaults={() => apiFetch(`/expeditions/divers/${emailExpId}/email-defaults`)}
          pdfUrl={`${API_URL}/expeditions/divers/${emailExpId}/pdf`}
          pdfAttachmentLabel={`BL-${emailExpId}.pdf`}
          onSend={(p) => postEmail(`${API_URL}/expeditions/divers/${emailExpId}/email`, p, { includeAttachPdf: true })}
        />
      )}

      <ConfirmDialog
        open={confirmShip}
        variant="default"
        title="Expédier l'article"
        description={
          `Expédier ${fmtNum(qtyNum, 1)} ${uniteLabel} de ${diversArticleLabel(data?.ref_designation ?? '', data?.variation1_label, data?.variation2_label)} ?`
          + ' La quantité est ajoutée au dernier carton de l’expédition en cours (créée si besoin) et déduite du stock.'
        }
        confirmLabel="Expédier"
        isPending={shipMut.isPending}
        onCancel={() => setConfirmShip(false)}
        onConfirm={() => shipMut.mutate(qtyNum)}
      />
    </>
  )
}

// ── Expédition groupée (legacy FEN_Expéditions_Groupées) ──

/** One divers line of the order, with what it still owes and what's on hand. */
interface DiversOrderLine {
  IDligne_commande_client: number
  IDref_divers: number
  ref_designation: string
  IDVariation1: number
  variation1_label: string | null
  IDVariation2: number
  variation2_label: string | null
  unite: number
  unite_label: string
  prix: number
  quantite_commandee: number
  quantite_expediee: number
  reste: number
  stock_disponible: number | null
}
interface DiversGroupPayload {
  lignes: DiversOrderLine[]
  expeditions: DiversShipExpedition[]
  defaults: { IDclient: number; IDadresse: number; IDtransporteur: number; ref_client: string } | null
}
interface TransporteurLite { IDtransporteur: number; nom: string }

/** One line of `PUT /expeditions/divers/lignes/:id/contenu` — the carton's
 *  whole content in a single call, keyed on the article combo. */
interface DiversContenuItem {
  IDref_divers: number
  IDVariation1: number
  IDVariation2: number
  quantite: number
  prix: number
}

/** A row of the carton content editor: one (ref × variation1 × variation2)
 *  combo, merging what the order asks for with what the carton already holds. */
interface ContentRow {
  key: string
  IDref_divers: number
  IDVariation1: number
  IDVariation2: number
  ref_designation: string
  variation1_label: string | null
  variation2_label: string | null
  prix: number
  /** Quantity on the order for this combo — 0 for an off-order carton item. */
  commandee: number
  /** Already shipped on this order by the OTHER cartons. */
  ailleurs: number
  stock: number | null
  /** What this carton holds today, summed over duplicate rows. */
  current: number
  /** In the carton but not on the order — 61 such items live. */
  horsCommande: boolean
}

const comboKey = (ref: number, v1: number, v2: number) => `${ref}|${v1}|${v2}`
/** Kill float noise so `qty !== current` doesn't report a phantom edit. */
const round2q = (v: number) => Math.round(v * 100) / 100
/** Read a typed quantity; anything unparseable (or negative) counts as 0, so a
 *  half-typed cell never sends garbage and never blocks the save. */
const parseQty = (raw: string): number => {
  const v = Number(raw.trim().replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? round2q(v) : 0
}

/** Whole-order divers shipment editor: pick/create the expédition, set its
 *  header, organise cartons, and fill each carton from the order's articles.
 *
 *  Chrome follows `mps_designer §18.D` — navy band + zinc body of white cards
 *  + zinc footer strip. A dialog this size is a working surface, not a form;
 *  on a plain white sheet its panels had nothing to separate them.
 *
 *  Content editing is a per-carton **edit mode** (tickets #1098 / #1099), not
 *  an "ajouter un article" combobox. The combobox listed the order's lines in
 *  a popover that ran off the bottom of the screen, so a line that existed was
 *  simply unreachable — and picking articles one at a time meant re-opening it
 *  for every row. The editor shows every article of the order at once with an
 *  editable quantity, which is also what the legacy `FEN_Expedition_Groupé`
 *  did (`TABLE_RefExpedie` = the order's divers lines LEFT JOINed to the
 *  selected carton's `ref_divers_expedie`). */
function ExpeditionGroupeeDialog({
  open, commande, onClose, onMutationSuccess,
}: {
  open: boolean
  commande: CommandeDetail
  onClose: () => void
  onMutationSuccess: () => void
}) {
  const commandeId = commande.IDcommande_client
  const queryClient = useQueryClient()
  const queryKey = ['commande-client-divers-expeditions', commandeId]

  const { data, isLoading } = useQuery<DiversGroupPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/expeditions-divers`),
    enabled: open,
  })
  const { data: transporteurs } = useQuery<TransporteurLite[]>({
    queryKey: ['exp-transporteurs'],
    queryFn: () => apiFetch('/expeditions/lookups/transporteurs'),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['cc-adresses', commande.IDclient],
    queryFn: () => apiFetch(`/commandes-client/lookups/adresses?client=${commande.IDclient}`),
    enabled: open && commande.IDclient > 0,
  })

  const [expId, setExpId] = useState<number | null>(null)
  const [cartonId, setCartonId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Header drafts — text/date fields save on blur, selects on change, so the
  // modal never holds unsaved work the user can lose by closing it.
  const [draftDate, setDraftDate] = useState('')
  const [draftRef, setDraftRef] = useState('')
  const [deleteCarton, setDeleteCarton] = useState<DiversShipCarton | null>(null)
  // Carton content edit mode: `draftQty` is keyed on the (ref, v1, v2) combo,
  // and holds raw strings so a half-typed "1," is not clobbered mid-keystroke.
  const [editingContent, setEditingContent] = useState(false)
  const [draftQty, setDraftQty] = useState<Record<string, string>>({})
  const [contentFilter, setContentFilter] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const expeditions = useMemo(() => data?.expeditions ?? [], [data])
  const selectedExp = expeditions.find((e) => e.IDexpedition_divers === expId) ?? null
  const selectedCarton = selectedExp?.cartons.find((c) => c.IDligne_expedition_divers === cartonId)
    ?? selectedExp?.cartons[0] ?? null
  const locked = selectedExp ? selectedExp.locked === 1 : false
  const soldee = Number(commande.est_soldee) === 1
  const readOnly = locked || soldee

  // Land on the order's open shipment (or the most recent one) and keep the
  // selection valid as shipments/cartons come and go.
  useEffect(() => {
    if (!open) return
    if (expeditions.length === 0) { setExpId(null); return }
    const stillThere = expId !== null && expeditions.some((e) => e.IDexpedition_divers === expId)
    if (!stillThere) setExpId((expeditions.find((e) => e.locked === 0) ?? expeditions[0]).IDexpedition_divers)
  }, [open, expeditions, expId])

  useEffect(() => {
    if (!selectedExp) { setCartonId(null); return }
    const stillThere = cartonId !== null && selectedExp.cartons.some((c) => c.IDligne_expedition_divers === cartonId)
    if (!stillThere) setCartonId(selectedExp.cartons[0]?.IDligne_expedition_divers ?? null)
  }, [selectedExp, cartonId])

  // Re-seed the header drafts whenever the selected shipment changes.
  useEffect(() => {
    setDraftDate(hfsqlDateToInput(selectedExp?.date ?? null))
    setDraftRef(selectedExp?.ref_client ?? '')
  }, [selectedExp?.IDexpedition_divers, selectedExp?.date, selectedExp?.ref_client])

  useEffect(() => {
    if (!open) { setError(null); setEditingContent(false); setDraftQty({}); setContentFilter('') }
  }, [open])

  const refresh = useCallback(() => {
    // Also drops the per-line drawer cache — a grouped edit changes what a
    // line shows as expédié — and the stock caches, since shipping a divers
    // article decrements `stock_divers` (cache-sync rule in CLAUDE.md).
    queryClient.invalidateQueries({ queryKey: ['commande-client-divers-expeditions', commandeId] })
    queryClient.invalidateQueries({ queryKey: ['commande-client-divers-line', commandeId] })
    invalidateStockCaches(queryClient)
    onMutationSuccess()
  }, [queryClient, onMutationSuccess, commandeId])

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur')

  const createExpMut = useMutation({
    mutationFn: () => apiFetch<{ IDexpedition_divers: number }>(`/commandes-client/${commandeId}/expeditions-divers`, { method: 'POST' }),
    onSuccess: (r) => { setExpId(r.IDexpedition_divers); setError(null); refresh() },
    onError: fail,
  })
  const headerMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/expeditions/divers/${selectedExp!.IDexpedition_divers}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setError(null); refresh() },
    onError: fail,
  })
  const addCartonMut = useMutation({
    mutationFn: (detail_ligne: string) =>
      apiFetch(`/expeditions/divers/${selectedExp!.IDexpedition_divers}/lignes`, { method: 'POST', body: JSON.stringify({ detail_ligne }) }),
    onSuccess: () => { setError(null); refresh() },
    onError: fail,
  })
  const renameCartonMut = useMutation({
    mutationFn: ({ id, detail_ligne }: { id: number; detail_ligne: string }) =>
      apiFetch(`/expeditions/divers/lignes/${id}`, { method: 'PUT', body: JSON.stringify({ detail_ligne }) }),
    onSuccess: () => { setError(null); refresh() },
    onError: fail,
  })
  const deleteCartonMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/expeditions/divers/lignes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleteCarton(null); setError(null); refresh() },
    onError: fail,
  })
  const saveContenuMut = useMutation({
    mutationFn: (items: DiversContenuItem[]) =>
      apiFetch(`/expeditions/divers/lignes/${selectedCarton!.IDligne_expedition_divers}/contenu`, {
        method: 'PUT', body: JSON.stringify({ items }),
      }),
    onSuccess: () => { setEditingContent(false); setDraftQty({}); setContentFilter(''); setError(null); refresh() },
    onError: fail,
  })

  const lignes = useMemo(() => data?.lignes ?? [], [data])

  // One row per (ref, variation1, variation2) combo — the unit the user reads
  // and the unit the invoice groups on. Two sources are merged:
  //  - the order's divers lines (7 live orders carry the same combo on two
  //    lines, so quantities are summed rather than listed twice), and
  //  - anything already in the carton whose combo is NOT on the order (61 of
  //    1 589 live items), which would otherwise be invisible here and
  //    therefore impossible to correct.
  const contentRows = useMemo<ContentRow[]>(() => {
    const inCarton = new Map<string, number>()
    for (const it of selectedCarton?.items ?? []) {
      const k = comboKey(it.IDref_divers, it.IDVariation1, it.IDVariation2)
      inCarton.set(k, round2q((inCarton.get(k) ?? 0) + it.quantite))
    }
    const rows = new Map<string, ContentRow>()
    for (const l of lignes) {
      const k = comboKey(l.IDref_divers, l.IDVariation1, l.IDVariation2)
      const prev = rows.get(k)
      if (prev) { prev.commandee = round2q(prev.commandee + l.quantite_commandee); continue }
      const current = inCarton.get(k) ?? 0
      rows.set(k, {
        key: k,
        IDref_divers: l.IDref_divers,
        IDVariation1: l.IDVariation1,
        IDVariation2: l.IDVariation2,
        ref_designation: l.ref_designation,
        variation1_label: l.variation1_label,
        variation2_label: l.variation2_label,
        prix: l.prix,
        commandee: l.quantite_commandee,
        // `quantite_expediee` counts the whole order, this carton included —
        // subtract it so the ceiling stays put while the user types.
        ailleurs: round2q(Math.max(0, l.quantite_expediee - current)),
        stock: l.stock_disponible,
        current,
        horsCommande: false,
      })
    }
    for (const [k, qty] of inCarton) {
      if (rows.has(k)) continue
      const it = (selectedCarton?.items ?? []).find(
        (i) => comboKey(i.IDref_divers, i.IDVariation1, i.IDVariation2) === k,
      )
      if (!it) continue
      rows.set(k, {
        key: k,
        IDref_divers: it.IDref_divers,
        IDVariation1: it.IDVariation1,
        IDVariation2: it.IDVariation2,
        ref_designation: it.designation.trim() || it.ref_designation,
        variation1_label: it.variation1_label,
        variation2_label: it.variation2_label,
        prix: it.prix,
        commandee: 0,
        ailleurs: 0,
        stock: null,
        current: qty,
        horsCommande: true,
      })
    }
    return [...rows.values()]
  }, [lignes, selectedCarton])

  /** What may still go into THIS carton for a combo: the order quantity minus
   *  what the other cartons already carry. 0 for an off-order row. */
  const resteOf = (r: ContentRow) => round2q(Math.max(0, r.commandee - r.ailleurs))

  const filteredRows = useMemo(() => {
    const q = contentFilter.trim().toLowerCase()
    if (!q) return contentRows
    const terms = q.split(/\s+/)
    return contentRows.filter((r) => {
      const hay = `${r.ref_designation} ${r.variation1_label ?? ''} ${r.variation2_label ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [contentRows, contentFilter])

  const qtyOf = (r: ContentRow) => (editingContent ? parseQty(draftQty[r.key] ?? '') : r.current)
  const contentDirty = editingContent && contentRows.some((r) => qtyOf(r) !== r.current)
  const draftTotalQty = round2q(contentRows.reduce((s, r) => s + qtyOf(r), 0))
  const draftTotalEur = round2q(contentRows.reduce((s, r) => s + qtyOf(r) * r.prix, 0))

  const startEditContent = () => {
    const seed: Record<string, string> = {}
    for (const r of contentRows) seed[r.key] = r.current > 0 ? String(r.current) : ''
    setDraftQty(seed)
    setContentFilter('')
    setEditingContent(true)
  }
  const cancelEditContent = () => { setEditingContent(false); setDraftQty({}); setContentFilter('') }
  /** Fill every VISIBLE row with what it still owes — the one-click "ce carton
   *  emporte le reste de la commande". Scoped to the filter so it can be aimed. */
  const fillRemaining = () => {
    setDraftQty((prev) => {
      const next = { ...prev }
      for (const r of filteredRows) {
        const reste = resteOf(r)
        if (reste > 0) next[r.key] = String(reste)
      }
      return next
    })
  }
  const saveContent = () => {
    saveContenuMut.mutate(contentRows.map((r) => ({
      IDref_divers: r.IDref_divers,
      IDVariation1: r.IDVariation1,
      IDVariation2: r.IDVariation2,
      quantite: qtyOf(r),
      prix: r.prix,
    })))
  }

  const requestClose = () => {
    if (contentDirty) { setConfirmDiscard(true); return }
    onClose()
  }

  if (!open) return null

  const cartonTotal = (c: DiversShipCarton) => c.items.reduce((s, i) => s + i.quantite, 0)
  const expTotalEur = selectedExp
    ? selectedExp.cartons.reduce((s, c) => s + c.items.reduce((is, i) => is + i.quantite * i.prix, 0), 0)
    : 0
  const cartonCount = selectedExp?.cartons.length ?? 0

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) requestClose() }}>
        {/* Edge treatment — mps_designer §18.D. `border-0` drops the primitive's
            hairline border, and `bg-zinc-100` replaces its near-white
            `bg-background`: the body and footer layers are translucent zinc, so
            whatever the dialog itself is painted in shows through them and at
            the rounded corners. White there reads as a leftover frame. */}
        <DialogContent className="max-w-5xl w-[92vw] h-[85vh] p-0 border-0 bg-primary overflow-hidden flex flex-col">
          {/* Header band — mps_designer §43 / §18.D */}
          <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
            <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
              <Boxes className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                Expédition groupée
              </h2>
              <p className="text-xs text-white/70 truncate">
                N° {commande.numero ?? commande.IDcommande_client} · {commande.client_nom || '—'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <Button
                variant="ghost" size="icon"
                className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white"
                title="Bon de livraison" disabled={!selectedExp}
                onClick={() => selectedExp && window.open(`${API_URL}/expeditions/divers/${selectedExp.IDexpedition_divers}/pdf`, '_blank')}
              >
                <Printer className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="icon"
                className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white"
                title="Fermer" onClick={requestClose}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex-1 flex items-center justify-center bg-zinc-100"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
          ) : expeditions.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-100 text-muted-foreground">
              <Truck className="h-12 w-12 opacity-40" />
              <p className="text-sm font-medium">Aucune expédition sur cette commande</p>
              {!soldee && (
                <Button size="sm" onClick={() => createExpMut.mutate()} disabled={createExpMut.isPending}>
                  {createExpMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                  Nouvelle expédition
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 min-h-0 flex flex-col gap-3 bg-zinc-100 p-4">
                {/* Shipment header. Deliberately dense — 3 columns × 2 rows of
                    `size="sm"` controls rather than 2 × 3 of full-height ones:
                    it is context the user sets once, and every pixel it gives
                    back goes to the carton table underneath, which is the part
                    that actually scrolls. */}
                <div className="flex-shrink-0 rounded-lg border border-border/60 bg-card px-3 py-2.5 shadow-sm grid grid-cols-3 gap-x-3 gap-y-2">
                  <div className="space-y-0.5">
                    <label className="text-[11px] font-medium text-muted-foreground">Expédition</label>
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 min-w-0">
                        <PopoverSelect
                          options={expeditions.map((e) => ({
                            id: e.IDexpedition_divers,
                            primary: `N° ${e.IDexpedition_divers}${e.date ? ` du ${formatHfsqlDate(e.date)}` : ''}`,
                            secondary: e.est_facture ? 'facturée' : undefined,
                          }))}
                          value={expId ?? 0}
                          onChange={(id) => setExpId(id || null)}
                          disabled={editingContent}
                          disabledTitle="Terminez la saisie du carton d'abord"
                          size="sm" widthClass="w-full"
                          hideEmpty
                        />
                      </div>
                      {!soldee && (
                        <Button variant="outline" size="icon" className="h-7 w-7 flex-shrink-0" title="Nouvelle expédition"
                          onClick={() => createExpMut.mutate()} disabled={createExpMut.isPending || editingContent}>
                          {createExpMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[11px] font-medium text-muted-foreground">Date</label>
                    <input
                      type="date"
                      value={draftDate}
                      disabled={readOnly}
                      onChange={(e) => setDraftDate(e.target.value)}
                      onBlur={() => {
                        if (readOnly || !selectedExp) return
                        if (draftDate === hfsqlDateToInput(selectedExp.date)) return
                        headerMut.mutate({ date: inputDateToHfsql(draftDate) })
                      }}
                      className={cn('w-full h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring', readOnly && 'bg-zinc-100 text-muted-foreground')}
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[11px] font-medium text-muted-foreground">Transporteur</label>
                    <PopoverSelect
                      options={(transporteurs ?? []).map((t) => ({ id: t.IDtransporteur, primary: t.nom }))}
                      value={selectedExp?.IDtransporteur ?? 0}
                      onChange={(id) => { if (!readOnly) headerMut.mutate({ IDtransporteur: id }) }}
                      disabled={readOnly}
                      size="sm" widthClass="w-full"
                      emptyLabel="— aucun —"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <label className="text-[11px] font-medium text-muted-foreground">Référence client</label>
                    <input
                      type="text"
                      value={draftRef}
                      disabled={readOnly}
                      onChange={(e) => setDraftRef(e.target.value)}
                      onBlur={() => {
                        if (readOnly || !selectedExp) return
                        if (draftRef === (selectedExp.ref_client ?? '')) return
                        headerMut.mutate({ ref_client: draftRef })
                      }}
                      className={cn('w-full h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring', readOnly && 'bg-zinc-100 text-muted-foreground')}
                    />
                  </div>
                  <div className="space-y-0.5 col-span-2">
                    <label className="text-[11px] font-medium text-muted-foreground">Adresse de livraison</label>
                    <PopoverSelect
                      options={(adresses ?? []).map(adresseOption)}
                      value={selectedExp?.IDadresse ?? 0}
                      onChange={(id) => { if (!readOnly) headerMut.mutate({ IDadresse: id }) }}
                      disabled={readOnly}
                      size="sm" widthClass="w-full"
                      emptyLabel="— aucune —"
                    />
                  </div>
                </div>

                {readOnly && (
                  <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg border border-border/60 bg-zinc-200/60 text-[11px] text-muted-foreground">
                    <Lock className="h-3.5 w-3.5 flex-shrink-0" />
                    {soldee ? 'Commande terminée — expédition en lecture seule.' : 'Expédition facturée — non modifiable.'}
                  </div>
                )}

                {/* Cartons (left) + the selected carton's articles (right) */}
                <div className="flex-1 min-h-0 flex gap-3">
                  <div className="w-56 flex-shrink-0 flex flex-col rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                    <div className="flex-shrink-0 px-3 py-2 border-b border-border/60 bg-zinc-200/50 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      Conteneurs ({cartonCount})
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5 scrollbar-transparent">
                      {(selectedExp?.cartons ?? []).map((c) => {
                        const active = selectedCarton?.IDligne_expedition_divers === c.IDligne_expedition_divers
                        return (
                          <button
                            key={c.IDligne_expedition_divers}
                            type="button"
                            // Switching carton mid-edit would silently drop the
                            // draft — the edit stays pinned to one carton.
                            disabled={editingContent && !active}
                            title={editingContent && !active ? "Terminez la saisie du carton d'abord" : undefined}
                            onClick={() => setCartonId(c.IDligne_expedition_divers)}
                            className={cn(
                              'w-full text-left p-2.5 rounded-lg border bg-card shadow-sm transition-colors',
                              active ? 'border-accent ring-1 ring-accent' : 'border-border/60 hover:border-accent/40',
                              editingContent && !active && 'opacity-50 cursor-not-allowed hover:border-border/60',
                            )}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <Package className="h-4 w-4 text-amber-600 flex-shrink-0" />
                              <span className="text-sm font-medium truncate">{c.detail_ligne || '—'}</span>
                            </span>
                            <span className="block mt-1 ml-6 text-[11px] text-muted-foreground tabular-nums">
                              {c.items.length} article{c.items.length > 1 ? 's' : ''} · {fmtNum(cartonTotal(c), 1)}
                            </span>
                          </button>
                        )
                      })}
                      {!readOnly && !editingContent && (
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => addCartonMut.mutate(`CARTON ${cartonCount + 1}`)}
                          disabled={addCartonMut.isPending}
                          className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un carton
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 min-w-0 flex flex-col rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                    {selectedCarton ? (
                      <>
                        <div className="flex-shrink-0 px-3 py-2 border-b border-border/60 bg-zinc-200/50 flex items-center gap-2">
                          <Package className="h-4 w-4 text-amber-600 flex-shrink-0" />
                          <input
                            key={selectedCarton.IDligne_expedition_divers}
                            type="text"
                            defaultValue={selectedCarton.detail_ligne}
                            disabled={readOnly}
                            onBlur={(e) => {
                              const v = e.target.value
                              if (readOnly || v === selectedCarton.detail_ligne) return
                              renameCartonMut.mutate({ id: selectedCarton.IDligne_expedition_divers, detail_ligne: v })
                            }}
                            className={cn('flex-1 min-w-0 h-7 px-2 text-sm font-medium rounded-md border border-transparent bg-transparent hover:border-input focus:border-input focus:bg-white focus:outline-none focus:ring-2 focus:ring-ring', readOnly && 'hover:border-transparent')}
                          />
                          {!readOnly && (editingContent ? (
                            <>
                              <Button variant="outline" size="sm" className="h-7 flex-shrink-0"
                                onClick={cancelEditContent} disabled={saveContenuMut.isPending}>
                                <X className="h-3.5 w-3.5 mr-1.5" />Annuler
                              </Button>
                              <Button size="sm" className="h-7 flex-shrink-0"
                                onClick={saveContent} disabled={!contentDirty || saveContenuMut.isPending}>
                                {saveContenuMut.isPending
                                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                  : <Save className="h-3.5 w-3.5 mr-1.5" />}
                                Enregistrer
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button variant="gold" size="sm" className="h-7 flex-shrink-0" onClick={startEditContent}>
                                <Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier le contenu
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive flex-shrink-0"
                                title="Supprimer le carton" onClick={() => setDeleteCarton(selectedCarton)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ))}
                        </div>

                        {editingContent && (
                          <div className="flex-shrink-0 px-2.5 py-2 border-b border-border/60 bg-zinc-100/80 flex items-center gap-2">
                            <div className="relative flex-1 min-w-0">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                              <input
                                type="text"
                                value={contentFilter}
                                onChange={(e) => setContentFilter(e.target.value)}
                                placeholder="Filtrer les articles de la commande"
                                className="h-7 w-full pl-8 pr-2 text-xs rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <Button variant="outline" size="sm" className="h-7 flex-shrink-0" onClick={fillRemaining}
                              title="Reporter, sur chaque article affiché, ce qu'il reste à expédier">
                              Remplir
                            </Button>
                          </div>
                        )}

                        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent">
                          {editingContent ? (
                            <table className="w-full text-xs">
                              <thead className="bg-zinc-200/60 border-b border-border/60 sticky top-0 z-10">
                                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  <th className="px-2.5 py-2 font-semibold text-left w-full">Référence</th>
                                  <th className="px-2.5 py-2 font-semibold text-left whitespace-nowrap">Variation 1</th>
                                  <th className="px-2.5 py-2 font-semibold text-left whitespace-nowrap">Variation 2</th>
                                  <th className="px-2 py-2 font-semibold text-right" title="Quantité commandée">Cmdé</th>
                                  {/* ⚠️ "Reste", not "Cmdé", is the number that fills the line.
                                      Measured on the live base: 1 443 of 1 770 divers order-line
                                      combos (81.5 %) are already shipped in part or in full, so
                                      filling from the ordered quantity would double-ship the
                                      majority of lines. Cmdé stays as context — never make it
                                      clickable. */}
                                  <th className="px-2 py-2 font-semibold text-right" title="Reste à expédier une fois ce carton enregistré">Reste</th>
                                  <th className="px-2 py-2 font-semibold text-right" title="Stock disponible une fois ce carton enregistré">Stock</th>
                                  <th className="px-2.5 py-2 font-semibold text-right whitespace-nowrap">Dans ce carton</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredRows.length === 0 && (
                                  <tr><td colSpan={7} className="px-2.5 py-6 text-center text-muted-foreground italic">
                                    {contentRows.length === 0 ? 'Aucun article divers sur cette commande' : 'Aucun article ne correspond au filtre'}
                                  </td></tr>
                                )}
                                {filteredRows.map((r) => {
                                  const reste = resteOf(r)   // ceiling for this carton, fixed
                                  const qty = qtyOf(r)
                                  // Reste and Stock are shown as they WILL BE once this carton is
                                  // saved, so both count down live as the quantity is typed —
                                  // "what is still owed" and "what is still on the shelf".
                                  const resteApres = round2q(reste - qty)
                                  // ⚠️ The stored stock already has this carton's current content
                                  // taken off it (shipping decrements `stock_divers` at write
                                  // time). So the baseline is stock + current — empty the carton
                                  // first, then take off what is typed. Comparing the typed
                                  // quantity against the raw stored stock, as this did before,
                                  // flagged an UNCHANGED row as over-stock the moment the article
                                  // was the last of its kind: 5 in the carton, stock reads 0, and
                                  // re-saving the same 5 lit every input amber.
                                  const stockBase = r.stock === null ? null : round2q(r.stock + r.current)
                                  const stockApres = stockBase === null ? null : round2q(stockBase - qty)
                                  // Both stay warnings, never blocks: `stock_divers` is sparse
                                  // (584 of 1 770 order-line combos have no row at all), so
                                  // refusing would make untracked articles unshippable.
                                  const overStock = stockApres !== null && stockApres < 0
                                  const overReste = !r.horsCommande && resteApres < 0
                                  return (
                                    <tr key={r.key} className={cn(
                                      'border-b border-border/40 last:border-0',
                                      qty > 0 ? 'bg-accent/[0.06]' : 'hover:bg-accent/5',
                                    )}>
                                      <td className="px-2.5 py-1.5 truncate font-medium" title={r.ref_designation}>
                                        {r.ref_designation || `Réf #${r.IDref_divers}`}
                                        {r.horsCommande && (
                                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground italic">hors commande</span>
                                        )}
                                      </td>
                                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.variation1_label || '—'}</td>
                                      <td className="px-2.5 py-1.5 whitespace-nowrap">{r.variation2_label || '—'}</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                                        {r.commandee > 0 ? fmtNum(r.commandee, 1) : '—'}
                                      </td>
                                      <td
                                        className="px-2 py-1.5 text-right tabular-nums"
                                        // Explains the gap when Reste < Cmdé — otherwise nothing
                                        // on the row says where the missing quantity went.
                                        title={!r.horsCommande && r.ailleurs > 0
                                          ? `Déjà expédié ailleurs : ${fmtNum(r.ailleurs, 1)}` : undefined}
                                      >
                                        {r.horsCommande ? (
                                          <span className="text-muted-foreground">—</span>
                                        ) : resteApres > 0 ? (
                                          // Clickable only while something is still owed. It fills
                                          // to the CEILING, not to the displayed figure — which is
                                          // the same thing, since the display is the ceiling minus
                                          // what is already typed.
                                          <button
                                            type="button"
                                            onClick={() => setDraftQty((p) => ({ ...p, [r.key]: String(reste) }))}
                                            className="rounded px-1 -mx-1 text-accent hover:bg-accent/10 transition-colors"
                                            title="Mettre tout le reste dans ce carton"
                                          >
                                            {fmtNum(resteApres, 1)}
                                          </button>
                                        ) : (
                                          <span className={cn(overReste ? 'text-amber-700 font-medium' : 'text-muted-foreground')}>
                                            {fmtNum(resteApres, 1)}
                                          </span>
                                        )}
                                      </td>
                                      <td className={cn('px-2 py-1.5 text-right tabular-nums',
                                        overStock ? 'text-amber-700 font-medium' : 'text-muted-foreground')}>
                                        {stockApres !== null ? fmtNum(stockApres, 1) : '—'}
                                      </td>
                                      <td className="px-2.5 py-1.5 text-right">
                                        <input
                                          type="text"
                                          inputMode="decimal"
                                          value={draftQty[r.key] ?? ''}
                                          // No placeholder: `0` is a LEGAL value here (it takes the
                                          // article out of the carton), so a greyed-out "0" is
                                          // indistinguishable from a typed one. An empty cell must
                                          // look empty.
                                          // Select-on-focus is the grid convention for quantity
                                          // cells — click a filled cell and typing REPLACES it,
                                          // instead of appending ("5" + "4" → "54").
                                          onFocus={(e) => e.currentTarget.select()}
                                          onChange={(e) => setDraftQty((p) => ({ ...p, [r.key]: e.target.value }))}
                                          title={overStock ? `Dépasse le stock disponible de ${fmtNum(-stockApres!, 1)}`
                                            : overReste ? `Dépasse le reste à expédier de ${fmtNum(-resteApres, 1)}` : undefined}
                                          className={cn(
                                            'h-7 w-24 px-1.5 text-xs text-right tabular-nums rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-ring',
                                            overStock || overReste ? 'border-amber-500 text-amber-800' : 'border-input',
                                          )}
                                        />
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="bg-zinc-200/60 border-b border-border/60 sticky top-0 z-10">
                                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                  <th className="px-2.5 py-2 font-semibold text-left w-full">Référence</th>
                                  <th className="px-2.5 py-2 font-semibold text-left whitespace-nowrap">Variation 1</th>
                                  <th className="px-2.5 py-2 font-semibold text-left whitespace-nowrap">Variation 2</th>
                                  <th className="px-2.5 py-2 font-semibold text-right">Quantité</th>
                                  <th className="px-2.5 py-2 font-semibold text-right">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* No call-to-action here: the strip directly above already
                                    carries "Modifier le contenu" at all times, so an empty
                                    carton needs the message and nothing else (§7.1's centred
                                    empty-state button is for lists whose only entry point it is). */}
                                {selectedCarton.items.length === 0 && (
                                  <tr><td colSpan={5} className="px-2.5 py-8 text-center text-muted-foreground italic">
                                    Aucun article dans ce carton
                                  </td></tr>
                                )}
                                {selectedCarton.items.map((it) => (
                                  <tr key={it.IDref_divers_expedie} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                                    <td className="px-2.5 py-1.5 truncate font-medium" title={it.ref_designation}>
                                      {it.designation.trim() || it.ref_designation || `Réf #${it.IDref_divers}`}
                                    </td>
                                    <td className="px-2.5 py-1.5 whitespace-nowrap">{it.variation1_label || '—'}</td>
                                    <td className="px-2.5 py-1.5 whitespace-nowrap">{it.variation2_label || '—'}</td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(it.quantite, 1)}</td>
                                    <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtNum(it.quantite * it.prix, 2)} €</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                        <Package className="h-10 w-10 opacity-40" />
                        <p className="text-sm">Aucun carton — ajoutez-en un pour commencer</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Footer strip */}
              <div className="flex-shrink-0 flex items-center gap-3 rounded-b-lg border-t border-border/60 bg-zinc-200 px-4 py-3">
                {error ? (
                  <div className="flex items-center gap-2 text-sm text-destructive min-w-0">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" /><span className="truncate">{error}</span>
                  </div>
                ) : (
                  // Quantities only — no money. This dialog packs cartons; the
                  // value of what is in them belongs to the facture.
                  <span className="text-xs text-muted-foreground tabular-nums truncate">
                    {editingContent
                      ? `Carton en cours : ${fmtNum(draftTotalQty, 1)}`
                      : `${cartonCount} carton${cartonCount > 1 ? 's' : ''}`}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={requestClose}>Fermer</Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteCarton !== null}
        title="Supprimer le carton"
        description="Le carton et tous ses articles seront supprimés, et les quantités remises en stock."
        confirmLabel="Supprimer"
        isPending={deleteCartonMut.isPending}
        onCancel={() => setDeleteCarton(null)}
        onConfirm={() => { if (deleteCarton) deleteCartonMut.mutate(deleteCarton.IDligne_expedition_divers) }}
      />

      <ConfirmDialog
        open={confirmDiscard}
        title="Abandonner la saisie"
        description="Les quantités saisies dans ce carton n'ont pas été enregistrées et seront perdues."
        confirmLabel="Abandonner"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => { setConfirmDiscard(false); cancelEditContent(); onClose() }}
      />
    </>
  )
}

/** One-field edit modal for a roll's free-text observations (the blue
 *  banner). The red défaut report stays read-only here — it belongs to
 *  the quality workflow (sst reception / Qualité). */
function EditRollObsDialog({
  roll, kind, isPending, onCancel, onSave,
}: {
  roll: RollLite
  kind: 'ecru' | 'fini'
  isPending: boolean
  onCancel: () => void
  onSave: (observations: string) => void
}) {
  const [observations, setObservations] = useState(roll.observations ?? '')
  const dirty = (observations ?? '') !== (roll.observations ?? '')
  const Icon = kind === 'fini' ? FiniRollIcon : TmRollIcon
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <DialogContent className="max-w-lg" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-6 w-6 text-accent" />
            {kind === 'fini' ? 'Rouleau fini' : 'Rouleau écru'} · {roll.numero || `#${roll.id}`}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-1">
          <label className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Observations
          </label>
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            rows={4}
            autoFocus
            className="w-full rounded-md border border-blue-300 bg-blue-50/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
          />
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>Annuler</Button>
          <Button onClick={() => onSave(observations)} disabled={!dirty || isPending}>
            {isPending ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Ennoblissement roll affectation modal ──────────────
// Click an Ennoblissement supply row → reserve the dyer's input écru rolls
// (stock_ecru via IDref_commande_affectation) to this client fini line.
// Two-panel transfer (mps_designer §18.C): left = affected, right = available.

interface EnnoRollsPayload {
  kind: 'ecru'
  unite: number
  unite_label: string
  dim: 'metrage' | 'poids'
  target_qty: number
  rendement: number
  sst_nom: string | null
  reserved: number
  linked: RollLite[]
  available: RollLite[]
}

function EnnoblissementAffectationDialog({
  commandeId, ligneId, row, onClose, onSuccess,
}: {
  commandeId: number
  ligneId: number
  row: SupplyEnnoRow
  onClose: () => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const sstLineId = row.id
  const queryKey = ['commande-client-enno-rolls', commandeId, ligneId, sstLineId]
  const base = `/commandes-client/${commandeId}/lignes/${ligneId}/supply/ennoblissement/${sstLineId}/rolls`

  const { data, isLoading, isError } = useQuery<EnnoRollsPayload>({
    queryKey,
    queryFn: () => apiFetch(base),
  })
  // Affecting a roll writes stock_ecru.IDref_commande_affectation /
  // IDligne_commande_client — it leaves the free pool the stock screens list.
  const linkMut = useMutation({
    mutationFn: (stockId: number) => apiFetch(`${base}/${stockId}`, { method: 'PUT' }),
    onSuccess: (payload: EnnoRollsPayload) => { queryClient.setQueryData(queryKey, payload); invalidateStockCaches(queryClient); onSuccess() },
  })
  const unlinkMut = useMutation({
    mutationFn: (stockId: number) => apiFetch(`${base}/${stockId}`, { method: 'DELETE' }),
    onSuccess: (payload: EnnoRollsPayload) => { queryClient.setQueryData(queryKey, payload); invalidateStockCaches(queryClient); onSuccess() },
  })

  const linked = data?.linked ?? []
  const available = data?.available ?? []
  const uniteLabel = data?.unite_label ?? 'Ml'
  const target = data?.target_qty ?? 0
  const reserved = data?.reserved ?? 0
  const pct = target > 0 ? Math.min(100, (reserved / target) * 100) : 0
  const sstNom = data?.sst_nom ?? row.sous_traitant_nom ?? '—'

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Droplets className="h-5 w-5 text-accent" />
            Affecter le stock — {sstNom}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Commande ennoblisseur N°<span className="tabular-nums">{row.commande_id}</span> · {fmtSupplyDate(row.date_commande)}
        </p>

        {/* Progress: reserved toward the client line target */}
        <div className="mt-2 flex-shrink-0">
          <div className="flex items-center justify-between text-[11px] font-medium tabular-nums mb-1">
            <span className="text-muted-foreground uppercase tracking-wide">Affecté à la commande</span>
            <span className={cn(pct >= 99.9 ? 'text-green-600' : 'text-foreground')}>
              {fmtNum(reserved, 1)} / {fmtNum(target, 1)} {uniteLabel}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-200 overflow-hidden">
            <div className={cn('h-full rounded-full transition-all', pct >= 99.9 ? 'bg-green-500' : 'bg-accent')} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Two-panel transfer */}
        <div className="flex-1 min-h-0 flex gap-4 mt-3">
          {/* Left: affected to this client order */}
          <div className="flex-1 min-w-0 flex flex-col">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5 flex-shrink-0">
              Affecté à la commande ({linked.length})
            </h3>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 px-1 scrollbar-transparent">
              {linked.map((roll) => (
                <RollRow key={roll.id} roll={roll} dim="poids" action="unlink"
                  onAction={() => unlinkMut.mutate(roll.id)}
                  isBusy={unlinkMut.isPending && unlinkMut.variables === roll.id} />
              ))}
              {!isLoading && linked.length === 0 && (
                <p className="text-xs text-muted-foreground italic text-center py-6">Aucun rouleau affecté.</p>
              )}
            </div>
          </div>

          {/* Right: available at the dyer */}
          <div className="flex-1 min-w-0 flex flex-col">
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5 flex-shrink-0">
              Disponible chez l'ennoblisseur ({available.length})
            </h3>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 px-1 scrollbar-transparent">
              {isLoading && [1, 2, 3].map((i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
              {isError && (
                <div className="flex flex-col items-center justify-center py-6 text-destructive">
                  <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
                </div>
              )}
              {available.map((roll) => (
                <RollRow key={roll.id} roll={roll} dim="poids" action="link"
                  onAction={() => linkMut.mutate(roll.id)}
                  isBusy={linkMut.isPending && linkMut.variables === roll.id} />
              ))}
              {!isLoading && !isError && available.length === 0 && (
                <p className="text-xs text-muted-foreground italic text-center py-6">Aucun rouleau disponible.</p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Tricotage affectation modal ─────────────────────────
// Click a "Commandes tricoteur en cours" row → adjust the planning allocation
// (affectation_cmd_tricotage) of that knitting order to this client line.
// Knitting counterpart of the ennoblissement roll-transfer modal: here the
// allocation is a weight, not rolls (production hasn't happened yet).

function TricotageAffectationDialog({
  commandeId, ligneId, row, clientNom, reserved, target, dim, uniteLabel, rendement, refLabel, onClose, onSuccess,
}: {
  commandeId: number
  ligneId: number
  row: SupplyTricoRow
  clientNom?: string
  /** Combined affecté already on the line / commanded qty, in the line's dim. */
  reserved: number
  target: number
  dim: 'metrage' | 'poids'
  uniteLabel: string
  rendement: number
  refLabel?: string | null
  onClose: () => void
  onSuccess: () => void
}) {
  const current = Number(row.poids_affecte) || 0
  const [valueStr, setValueStr] = useState(() => (current !== 0 ? String(current) : ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = parseFloat(valueStr.replace(',', '.'))
  const value = Number.isFinite(parsed) ? parsed : 0
  const delta = value - current
  // Live remaining on the knitting order (its dispo already excludes the
  // current allocation, so only the delta moves it).
  const dispoLive = Math.round(((Number(row.poids_disponible) || 0) - delta) * 100) / 100
  const over = dispoLive < -0.005
  const projected = dim === 'metrage' ? reserved + delta * rendement : reserved + delta
  const canSubmit = !busy && !over && Math.abs(delta) > 0.0001

  const handleSubmit = async () => {
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/tricotage/${row.id}/affectation`, {
        method: 'PUT',
        body: JSON.stringify({ poids_affecte: value }),
      })
      onSuccess()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-md flex flex-col p-0 overflow-hidden" onClose={busy ? undefined : onClose}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <KnitIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">
              Affectation — Commande N° {row.commande_id}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {row.sous_traitant_nom || 'Tricoteur'} · {fmtSupplyDate(row.date_commande)}
              {row.etat_label && <> · <SupplyEtatPill label={row.etat_label} /></>}
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 bg-zinc-100/80 space-y-3">
          <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
            <TricoWeightField
              label={`Affecté à la commande${clientNom ? ` ${clientNom}` : ' client'}`}
              value={valueStr}
              onChange={setValueStr}
              disabled={busy}
              rendement={rendement}
              refLabel={refLabel}
              autoFocus
            />
            <div className={cn(
              'flex items-baseline justify-between gap-2 pt-2 border-t border-border/40 text-[11px] tabular-nums',
              over ? 'text-destructive font-medium' : 'text-muted-foreground',
            )}>
              <span>Disponible sur la commande tricoteur</span>
              <span>{fmtNum(dispoLive, 1)} kg</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <AffecteGauge projected={projected} target={target} uniteLabel={uniteLabel} clientNom={clientNom} />
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {busy
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Enregistrement…</>
                  : <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Tombé-de-métier disponible: per-location table + create-order dialog ──
// Ports the legacy "029 - écru disponible" panel: écru of this fini's écru ref
// available, aggregated by sous-traitant location (grouped chez les
// ennoblisseurs / à l'usine). Ennoblisseur rows carry a "Nouvelle commande"
// button that opens a create-order dialog scoped to that location's stock.

interface AvailableEcruRoll extends RollLite {
  reserved_elsewhere: boolean
  /** Already reserved to this client line — counted in affecte_total. */
  reserved_to_line: boolean
}
interface AvailableRollsPayload {
  unite: number
  unite_label: string
  dim: 'metrage' | 'poids'
  rendement: number
  rolls: AvailableEcruRoll[]
}
interface EnnoLocationRow {
  IDsous_traitant: number
  location_nom: string
  is_ennoblisseur: boolean
  group: 'ennoblisseur' | 'usine'
  nb_rolls: number
  poids: number
  metrage_potentiel: number
}
interface EnnoLocationsPayload {
  rendement: number
  unite_label: string
  ecru_ref_label: string
  /** Coloris the pool is filtered on ("ecru" for dyed finis, the line's own
   *  colori_ecru for wash-only finis); '' when unfiltered. */
  ecru_coloris_label: string
  locations: EnnoLocationRow[]
}

// Shared chrome for the grouped supply tables below — same container, header
// band and row typography as SupplyTable so the whole drawer tab reads as one
// visual grammar. Groups render as full-width zinc band rows inside the table.
function GroupBandRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-zinc-200/50 border-b border-border/40">
        {label}
      </td>
    </tr>
  )
}

// Aggregated écru-by-location table. Two labelled groups; the "Nouvelle
// commande" button shows only on ennoblisseur rows (you commission the dyer
// that holds the écru — matches the legacy launcher on the MATEL row).
function EnnoLocationTable({
  loading, locations, onNewOrder,
}: {
  loading: boolean
  locations: EnnoLocationRow[]
  onNewOrder: (loc: EnnoLocationRow) => void
}) {
  if (loading) {
    return <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded-md" />)}</div>
  }
  if (locations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <TmRollIcon className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">Aucun tombé de métier disponible</p>
        <p className="text-xs mt-1">Aucun rouleau écru disponible chez un sous-traitant.</p>
      </div>
    )
  }
  const groups: { label: string; rows: EnnoLocationRow[] }[] = [
    { label: 'Chez les ennoblisseurs', rows: locations.filter((l) => l.group === 'ennoblisseur') },
    { label: "À l'usine", rows: locations.filter((l) => l.group === 'usine') },
  ].filter((g) => g.rows.length > 0)
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.label}>
              <GroupBandRow label={g.label} colSpan={4} />
              {g.rows.map((loc) => (
                <tr key={loc.IDsous_traitant} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                  <td className="px-2.5 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <MapPin className="h-3.5 w-3.5 text-accent flex-shrink-0" />
                      {loc.location_nom}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums">{fmtNum(loc.poids, 1)} kg</td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{fmtNum(loc.metrage_potentiel, 0)} Ml</td>
                  <td className="px-2.5 py-1 whitespace-nowrap text-right">
                    {loc.is_ennoblisseur && (
                      <Button variant="ghost" size="sm" onClick={() => onNewOrder(loc)} className="h-7 text-accent hover:text-accent hover:bg-accent/10">
                        <Plus className="h-3.5 w-3.5 mr-1" />Nouvelle commande
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Tricotage: "Stock de fil disponible" (legacy right-hand panel) ──
// Yarn on hand matching the écru's composition, grouped by holding location.
// Métrage potentiel = fabric the yarn weight can produce (poids / % × rendement).

interface TricoStockFilYarn {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  pourcentage: number
  poids: number
  metrage_potentiel: number
}
interface TricoStockFilLocation {
  magasin_id: number
  magasin_nom: string
  is_tricoteur: boolean
  yarns: TricoStockFilYarn[]
}
interface TricoStockFilPayload {
  rendement: number
  ecru_ref_label: string
  locations: TricoStockFilLocation[]
}

function StockFilDispoTable({
  loading, locations, onNewOrder,
}: {
  loading: boolean
  locations: TricoStockFilLocation[]
  onNewOrder: (loc: TricoStockFilLocation) => void
}) {
  if (loading) {
    return <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded-md" />)}</div>
  }
  if (locations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <BobineIcon className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">Aucun stock de fil disponible</p>
        <p className="text-xs mt-1">Aucun lot de fil correspondant à la composition de cet écru.</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {locations.map((loc) => (
            <Fragment key={loc.magasin_id}>
              {/* Group band doubles as the header row: the location-name
                  column takes the flexible width (w-full) so the value
                  columns sit right, next to the content-width launcher column
                  on tricoteur locations. */}
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground bg-zinc-200/50 border-b border-border/40">
                <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-left w-full">{loc.magasin_nom}</td>
                <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-right">Compo.</td>
                <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-right">Poids</td>
                <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-right">Métrage pot.</td>
                <td className="px-2.5 py-0.5 whitespace-nowrap text-right">
                  {loc.is_tricoteur && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onNewOrder(loc)}
                      className="h-6 px-2 text-[11px] normal-case tracking-normal text-accent hover:text-accent hover:bg-accent/10"
                    >
                      <Plus className="h-3 w-3 mr-1" />Nouvelle commande
                    </Button>
                  )}
                </td>
              </tr>
              {loc.yarns.map((y) => {
                const noStock = !(y.poids > 0)
                // Legacy stores 6.4 as 6.400000095… — show one decimal only when needed.
                const pct = Math.round(y.pourcentage * 10) / 10
                return (
                  <tr key={`${y.IDref_fil}:${y.IDcolori_fil}`} className={cn('border-b border-border/40 last:border-0 hover:bg-accent/5', noStock && 'text-muted-foreground')}>
                    <td className="px-2.5 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <BobineIcon className={cn('h-3.5 w-3.5 flex-shrink-0', noStock ? 'text-muted-foreground/50' : 'text-accent')} />
                        {y.reference}{y.coloris ? ` - ${y.coloris}` : ''}
                      </span>
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums">
                      {pct > 0 ? `${fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} %` : '—'}
                    </td>
                    <td className="px-2.5 py-2 whitespace-nowrap text-right tabular-nums">{fmtNum(y.poids, 1)} kg</td>
                    <td className={cn('px-2.5 py-2 whitespace-nowrap text-right tabular-nums', y.metrage_potentiel > 0 && 'font-semibold')}>
                      {y.metrage_potentiel > 0 ? `${fmtNum(y.metrage_potentiel, 0)} Ml` : '—'}
                    </td>
                    <td />
                  </tr>
                )
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Shared footer gauge of the create-order modals: projected affecté vs the
// commanded quantity, with a mini progress bar (legacy: "801 / 800 Ml affecté
// à la commande de Le slip Français", green once covered).
function AffecteGauge({
  projected, target, uniteLabel, clientNom,
}: {
  projected: number
  target: number
  uniteLabel: string
  clientNom?: string
}) {
  const covered = target > 0 && projected >= target
  const pct = target > 0 ? Math.min(100, Math.max(0, (projected / target) * 100)) : 0
  return (
    <div className="min-w-0 flex-1">
      <p className={cn('text-xs font-medium tabular-nums truncate', covered ? 'text-green-600' : 'text-muted-foreground')}>
        <span className={cn('font-bold', !covered && 'text-foreground')}>{fmtNum(projected, 1)}</span>
        {' / '}{fmtNum(target, 1)} {uniteLabel} affecté à la commande{clientNom ? ` de ${clientNom}` : ''}
      </p>
      <div className="h-1.5 mt-1.5 rounded-full bg-white overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', covered ? 'bg-green-500' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Create a new ennoblisseur order from the écru held at ONE location (the row's
// sous-traitant = the dyer). Scoped roll list ("disponible chez X"), multi-
// select (nothing pre-selected), then POST creates the order + affects the rolls.
function CreateEnnoblisseurOrderDialog({
  commandeId, ligne, location, clientNom, reserved, target, dim, uniteLabel, onClose, onSuccess,
}: {
  commandeId: number
  ligne: LigneCommande
  location: EnnoLocationRow
  clientNom?: string
  /** Combined affecté already on the line / commanded qty, in the line's dim. */
  reserved: number
  target: number
  dim: 'metrage' | 'poids'
  uniteLabel: string
  onClose: () => void
  onSuccess: () => void
}) {
  const ligneId = ligne.IDligne_commande_client
  const [dateCommande, setDateCommande] = useState(() => new Date().toISOString().slice(0, 10))
  const [dateLivraison, setDateLivraison] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSelectedRef = useRef<number | null>(null)

  const { data, isLoading, isError } = useQuery<AvailableRollsPayload>({
    queryKey: ['commande-client-enno-available', commandeId, ligneId, location.IDsous_traitant],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/ennoblissement/available-rolls?magasin=${location.IDsous_traitant}`),
  })

  // Ascending by roll number (3377/1, 3377/2, … 3377/1001) — numeric-aware so
  // the suffix sorts as a number, not lexically.
  const rolls = useMemo(
    () => [...(data?.rolls ?? [])].sort((a, b) =>
      (a.numero ?? '').localeCompare(b.numero ?? '', 'fr', { numeric: true, sensitivity: 'base' })),
    [data],
  )
  const rendement = data?.rendement ?? 0
  // Nothing is pre-selected: the user picks the rolls to commission.

  const orderedIds = rolls.map((r) => r.id)
  const selectedKg = rolls.filter((r) => selected.has(r.id)).reduce((s, r) => s + (Number(r.poids) || 0), 0)
  const selectedMl = selectedKg * rendement
  const allSelected = rolls.length > 0 && rolls.every((r) => selected.has(r.id))
  // Gauge projection: only FREE selected rolls add to the line's affecté —
  // rolls already reserved to this line are inside `reserved`, and rolls
  // reserved to another line keep their reservation on create.
  const newKg = rolls
    .filter((r) => selected.has(r.id) && !r.reserved_to_line && !r.reserved_elsewhere)
    .reduce((s, r) => s + (Number(r.poids) || 0), 0)
  const projected = dim === 'metrage' ? reserved + newKg * rendement : reserved + newKg

  const selectAll = () => { setSelected(new Set(rolls.map((r) => r.id))); lastSelectedRef.current = rolls[rolls.length - 1]?.id ?? null }
  const clearSelection = () => { setSelected(new Set()); lastSelectedRef.current = null }

  const handleToggle = (id: number, shiftKey: boolean) => {
    const anchor = lastSelectedRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = orderedIds.indexOf(anchor)
      const b = orderedIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(orderedIds[i])
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
    lastSelectedRef.current = id
  }

  const canSubmit = selected.size > 0 && dateCommande.length > 0 && !busy
  const handleSubmit = async () => {
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/ennoblissement/orders`, {
        method: 'POST',
        body: JSON.stringify({
          IDsous_traitant: location.IDsous_traitant,
          date_commande: inputDateToHfsql(dateCommande),
          date_livraison: dateLivraison ? inputDateToHfsql(dateLivraison) : undefined,
          stockEcruIds: Array.from(selected),
        }),
      })
      onSuccess()
      onClose()
    } catch (e: any) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-2xl w-[92vw] h-[85vh] flex flex-col p-0 overflow-hidden" onClose={busy ? undefined : onClose}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <Droplets className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">Nouvelle commande — {location.location_nom}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {ligne.ref_label || `Réf ${ligne.IDreference}`}
              {ligne.colori_reference && ` · ${ligne.colori_reference}`}
            </p>
            <p className="text-[10px] text-muted-foreground/80 italic mt-0.5">Astuce : Maj+clic pour sélectionner une plage.</p>
          </div>
        </div>

        {/* Order dates */}
        <div className="flex-shrink-0 px-6 py-3 border-b bg-zinc-200/30 grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date commande</label>
            <input type="date" value={dateCommande} onChange={(e) => setDateCommande(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date d'expédition</label>
            <input type="date" value={dateLivraison} onChange={(e) => setDateLivraison(e.target.value)} className={inputCls} />
          </div>
        </div>

        {/* Disponible chez X — scoped roll list */}
        <div className="flex-shrink-0 px-4 py-1.5 flex items-center bg-zinc-100/80 border-b">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1.5">
            <MapPin className="h-3 w-3" />Disponible chez {location.location_nom}
          </span>
          {rolls.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                {selected.size > 0
                  ? `${selected.size} rouleau${selected.size > 1 ? 'x' : ''} · ${fmtNum(selectedKg, 1)} kg · ${fmtNum(selectedMl, 0)} Ml`
                  : 'Aucun rouleau sélectionné'}
              </span>
              <span className="text-muted-foreground/40 text-[11px]">—</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={selectAll} disabled={busy || allSelected}
                  className="text-[11px] text-accent hover:underline disabled:text-muted-foreground/50 disabled:no-underline disabled:cursor-default px-1">Tout</button>
                <span className="text-muted-foreground/40 text-[11px]">·</span>
                <button type="button" onClick={clearSelection} disabled={busy || selected.size === 0}
                  className="text-[11px] text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:cursor-default px-1">Aucun</button>
              </div>
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5 bg-zinc-100/80 scrollbar-transparent">
          {isLoading && <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />)}</div>}
          {isError && (
            <div className="flex flex-col items-center justify-center py-10 text-destructive">
              <AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Erreur de chargement</p>
            </div>
          )}
          {!isLoading && !isError && rolls.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Package className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm font-medium">Aucun rouleau disponible</p>
            </div>
          )}
          {rolls.map((roll) => (
            <SelectableEcruRoll
              key={roll.id}
              roll={roll}
              rendement={rendement}
              selected={selected.has(roll.id)}
              disabled={busy}
              onToggle={(shiftKey) => handleToggle(roll.id, shiftKey)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <AffecteGauge projected={projected} target={target} uniteLabel={uniteLabel} clientNom={clientNom} />
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {busy
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Création…</>
                  : <><Plus className="h-3.5 w-3.5 mr-1.5" />Créer la commande</>}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Selectable écru roll row. Click (or Shift+click for a range) toggles
// selection; shows poids + métrage potentiel (poids × rendement).
function SelectableEcruRoll({
  roll, rendement, selected, disabled, onToggle,
}: {
  roll: AvailableEcruRoll
  rendement: number
  selected: boolean
  disabled: boolean
  onToggle: (shiftKey: boolean) => void
}) {
  const poids = Number(roll.poids) || 0
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => onToggle(e.shiftKey)}
      className={cn(
        'w-full text-left rounded-lg border p-2.5 flex items-center gap-3 transition-colors disabled:opacity-60',
        selected ? 'border-accent ring-1 ring-accent bg-accent/[0.06]' : 'border-border/60 bg-card hover:border-accent/40',
      )}
    >
      <div className={cn('h-5 w-5 rounded flex items-center justify-center flex-shrink-0 border', selected ? 'bg-accent border-accent text-accent-foreground' : 'border-input bg-background')}>
        {selected && <CheckCircle2 className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold truncate">{roll.numero || `Rouleau ${roll.id}`}</span>
          {roll.lot && <span className="text-xs text-muted-foreground truncate">· Lot {roll.lot}</span>}
          {!!roll.second_choix && <Badge variant="secondary" className="text-[10px] py-0 px-1.5">2nd choix</Badge>}
          {roll.reserved_elsewhere && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/40 text-amber-700 bg-amber-500/10">Réservé ailleurs</Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{fmtNum(poids, 1)} kg</span>
          {rendement > 0 && <span>· {fmtNum(poids * rendement, 0)} Ml</span>}
          {roll.coloris_reference && <span className="truncate">· {roll.coloris_reference}</span>}
        </div>
      </div>
    </button>
  )
}

// ── Tricotage: create a knit order at a yarn-holding knitter ──
// Mirrors the legacy "Commande de Tricotage Malterre" modal launched from the
// Tricotage tab, generalized to any tricoteur location of the stock-fil
// panel: two kg inputs (affecté to this client commande / for the ETM stock)
// with live ml conversions, info tables (yarn stock at the knitter net of
// open OFs + yarn on order), and a footer gauge of the line's affected
// métrage. TRM orders get the cross-ledger mirror + Attente_Delai; external
// tricoteurs start Non_Envoye (bon de commande sent from the sst screen).

interface TricoOrderYarnLot { id: number; lot: string; fournisseur: string; poids: number; metrage: number }
interface TricoOrderYarnPending { id: number; date_livraison: string | null; fournisseur: string; poids: number; metrage: number }
interface TricoOrderYarn {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  pourcentage: number
  stock: TricoOrderYarnLot[]
  pending: TricoOrderYarnPending[]
}
interface TricoNewOrderContext {
  applicable: boolean
  ecru_ref_label?: string
  ecru_coloris_label?: string
  rendement?: number
  yarns?: TricoOrderYarn[]
}

function CreateTricotageOrderDialog({
  commandeId, ligne, location, clientNom, reserved, target, dim, uniteLabel, onClose, onSuccess,
}: {
  commandeId: number
  ligne: LigneCommande
  /** The knitter whose stock-fil band launched the dialog. */
  location: TricoStockFilLocation
  clientNom?: string
  /** Already affected to this line / commanded quantity, in the line's dim. */
  reserved: number
  target: number
  dim: 'metrage' | 'poids'
  uniteLabel: string
  onClose: () => void
  onSuccess: () => void
}) {
  const ligneId = ligne.IDligne_commande_client
  const [affecteStr, setAffecteStr] = useState('')
  const [stockStr, setStockStr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: ctx, isLoading } = useQuery<TricoNewOrderContext>({
    queryKey: ['commande-client-trico-neworder', commandeId, ligneId, location.magasin_id],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/tricotage/new-order-context?magasin=${location.magasin_id}`),
  })
  const rendement = ctx?.rendement ?? 0
  const yarns = ctx?.yarns ?? []

  const parseKg = (s: string) => {
    const v = parseFloat(s.replace(',', '.'))
    return Number.isFinite(v) ? v : 0
  }
  const affecte = parseKg(affecteStr)
  const stock = parseKg(stockStr)
  const total = Math.round((affecte + stock) * 100) / 100
  // Footer gauge: current affected + the new allocation, in the line's dim
  // (legacy: "801 / 800 Ml affecté à la commande de Le slip Français").
  const projected = dim === 'metrage' ? reserved + affecte * rendement : reserved + affecte
  const canSubmit = total > 0 && stock >= 0 && !busy

  const handleSubmit = async () => {
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      await apiFetch(`/commandes-client/${commandeId}/lignes/${ligneId}/supply/tricotage/orders`, {
        method: 'POST',
        body: JSON.stringify({ IDsous_traitant: location.magasin_id, poids_affecte: affecte, poids_stock: stock }),
      })
      onSuccess()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-3xl w-[92vw] max-h-[85vh] flex flex-col p-0 overflow-hidden" onClose={busy ? undefined : onClose}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <KnitIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">Nouvelle commande — {location.magasin_nom}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {ctx?.ecru_ref_label
                ? <>Tricotage de <span className="font-semibold text-foreground">{ctx.ecru_ref_label}{ctx.ecru_coloris_label ? ` · ${ctx.ecru_coloris_label}` : ''}</span></>
                : '…'}
              {yarns.length > 0 && (
                <> — {yarns.map((y) => {
                  const pct = Math.round(y.pourcentage * 10) / 10
                  return `${fmtNum(pct, Number.isInteger(pct) ? 0 : 1)} % ${y.reference}`
                }).join(' + ')}</>
              )}
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100/80 scrollbar-transparent">
          <div className="grid grid-cols-1 md:grid-cols-[280px,1fr] gap-4 items-start">
            {/* Left: weight split */}
            <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
              <div className="px-3 py-2 border-b border-border/40 bg-zinc-200/50">
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Répartition du poids</h3>
              </div>
              <div className="p-3 space-y-3">
                <TricoWeightField
                  label={`Affecté à la commande${clientNom ? ` ${clientNom}` : ' client'}`}
                  value={affecteStr}
                  onChange={setAffecteStr}
                  disabled={busy}
                  rendement={rendement}
                  refLabel={ligne.ref_label}
                  autoFocus
                />
                <div className="divider-warm" />
                <TricoWeightField
                  label="Pour le stock Ets Malterre"
                  value={stockStr}
                  onChange={setStockStr}
                  disabled={busy}
                  rendement={rendement}
                  refLabel={ligne.ref_label}
                />
              </div>
              <div className="px-3 py-2.5 border-t border-accent/25 bg-gradient-to-r from-gold/20 via-gold/10 to-transparent flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Poids total</span>
                <span className="text-lg font-bold tabular-nums">
                  {fmtNum(total, 1)} <span className="text-xs font-medium text-muted-foreground">kg</span>
                </span>
              </div>
            </div>

            {/* Right: yarn stock at TRM + on order */}
            <div className="space-y-4 min-w-0">
              <section>
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                  Stock disponible chez {location.magasin_nom}
                </h3>
                {isLoading ? (
                  <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded-md" />)}</div>
                ) : (
                  <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        {yarns.map((y) => (
                          <Fragment key={`${y.IDref_fil}:${y.IDcolori_fil}`}>
                            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground bg-zinc-200/50 border-b border-border/40">
                              <td colSpan={3} className="px-2.5 py-1 font-semibold whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <BobineIcon className="h-3.5 w-3.5 text-accent flex-shrink-0" />
                                  {y.reference}{y.coloris ? ` - ${y.coloris}` : ''}
                                </span>
                              </td>
                              <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-right tabular-nums">
                                {fmtNum(y.stock.reduce((s, l) => s + l.metrage, 0), 2)} Ml
                              </td>
                            </tr>
                            {y.stock.length === 0 && (
                              <tr className="border-b border-border/40 last:border-0">
                                <td colSpan={4} className="px-2.5 py-2 text-muted-foreground italic">Aucun lot en stock</td>
                              </tr>
                            )}
                            {y.stock.map((l) => (
                              <tr key={l.id} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                                <td className="px-2.5 py-1.5 whitespace-nowrap truncate max-w-[140px]">{l.fournisseur || '—'}</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap tabular-nums">{l.lot || '—'}</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums">{fmtNum(l.poids, 2)} kg</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums font-semibold">{fmtNum(l.metrage, 2)} Ml</td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                  En commande
                </h3>
                {isLoading ? (
                  <div className="space-y-2">{[1].map((i) => <div key={i} className="h-10 bg-muted animate-pulse rounded-md" />)}</div>
                ) : (
                  <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        {yarns.map((y) => (
                          <Fragment key={`${y.IDref_fil}:${y.IDcolori_fil}`}>
                            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground bg-zinc-200/50 border-b border-border/40">
                              <td colSpan={3} className="px-2.5 py-1 font-semibold whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <BobineIcon className="h-3.5 w-3.5 text-accent flex-shrink-0" />
                                  {y.reference}{y.coloris ? ` - ${y.coloris}` : ''}
                                </span>
                              </td>
                              <td className="px-2.5 py-1 font-semibold whitespace-nowrap text-right tabular-nums">
                                {fmtNum(y.pending.reduce((s, o) => s + o.metrage, 0), 2)} Ml
                              </td>
                            </tr>
                            {y.pending.length === 0 && (
                              <tr className="border-b border-border/40 last:border-0">
                                <td colSpan={4} className="px-2.5 py-2 text-muted-foreground italic">Aucune commande de fil en attente</td>
                              </tr>
                            )}
                            {y.pending.map((o) => (
                              <tr key={o.id} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                                <td className="px-2.5 py-1.5 whitespace-nowrap tabular-nums">{fmtSupplyDate(o.date_livraison)}</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap truncate max-w-[140px]">{o.fournisseur || '—'}</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums">{fmtNum(o.poids, 2)} kg</td>
                                <td className="px-2.5 py-1.5 whitespace-nowrap text-right tabular-nums font-semibold">{fmtNum(o.metrage, 2)} Ml</td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <AffecteGauge projected={projected} target={target} uniteLabel={uniteLabel} clientNom={clientNom} />
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {busy
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Création…</>
                  : <><Plus className="h-3.5 w-3.5 mr-1.5" />Créer la commande</>}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Weight input row of the knit-order modal: label above, right-aligned input
// with an inset "kg" unit, Ml conversion hint underneath (mirrors the legacy
// modal's "Environ X Ml de 029A" captions). Top-level component so the input
// keeps its identity (and focus) across parent re-renders.
function TricoWeightField({
  label, value, onChange, disabled, rendement, refLabel, autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
  rendement: number
  refLabel?: string | null
  autoFocus?: boolean
}) {
  const parsed = parseFloat(value.replace(',', '.'))
  const kg = Number.isFinite(parsed) ? parsed : 0
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <input
          type="text" inputMode="decimal" value={value} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} placeholder="0" autoFocus={autoFocus}
          className="w-full h-10 pl-3 pr-10 text-base font-semibold text-right tabular-nums rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">kg</span>
      </div>
      <p className="text-[11px] text-muted-foreground italic text-right tabular-nums h-4">
        {kg !== 0 && rendement > 0 ? `≈ ${fmtNum(kg * rendement, 1)} Ml${refLabel ? ` de ${refLabel}` : ''}` : ''}
      </p>
    </div>
  )
}

// ── Line create/edit dialog ────────────────────────────

function LineFormDialog({
  open, commande, line, onClose, onSuccess,
}: {
  open: boolean
  commande: CommandeDetail
  line: LigneCommande | null
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = line === null
  const [form, setForm] = useState<LineFormState>(emptyLineForm)
  const [error, setError] = useState<string | null>(null)
  // Price lock: when locked, the price auto-fills from the tariff and the input
  // is read-only (the legacy padlock). New lines start locked (auto); existing
  // lines start unlocked so a previously-saved/overridden price is preserved.
  const [priceLocked, setPriceLocked] = useState(true)
  // Manual price override is permission-gated: without it the padlock is hidden
  // and tariff-priced lines (écru/fini) keep their computed/saved price.
  const canUnlockPrice = useHasPermission('deverrouiller_tarifs')
  // Debounced quantity for the auto-price query (avoid a request per keystroke).
  const [debouncedQuantite, setDebouncedQuantite] = useState('')
  // Divers (type 3) don't go through the roll-tranche tariff: their price is a
  // flat per-(ref, variation1, variation2) cell of the tarif_divers grid. Same
  // resolver + free manual override as the Expéditions article dialog — no
  // padlock, because this is a catalogue price, not a computed tariff.
  const [diversPrixTouched, setDiversPrixTouched] = useState(false)

  useEffect(() => {
    if (!open) return
    if (line) {
      setForm({
        type: line.type || 2,
        IDreference: line.IDreference || 0,
        IDcolori: line.IDcolori || 0,
        IDVariation1: line.IDVariation1 || 0,
        IDVariation2: line.IDVariation2 || 0,
        quantite: line.quantite != null ? String(line.quantite) : '',
        unite: line.unite || 3,
        prix: line.prix != null ? String(line.prix) : '',
        date_livraison: hfsqlDateToInput(line.date_livraison),
        commentaire: line.commentaire ?? '',
      })
      setPriceLocked(false) // preserve the saved price until the user re-locks
      // Same intent for divers, except a stored 0 is not a price worth keeping
      // (lines created before divers were grid-priced) — let the grid fill it.
      setDiversPrixTouched(Number(line.prix) > 0)
    } else {
      setForm(emptyLineForm)
      setPriceLocked(true)
      setDiversPrixTouched(false)
    }
    setError(null)
  }, [open, line])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuantite(form.quantite), 300)
    return () => clearTimeout(t)
  }, [form.quantite])

  // Auto-price + roll-count note (PrixDeVenteV4 port). Écru/fini + Kg/Ml only.
  const priceableType = form.type === 1 || form.type === 2
  // Gate every price-derived note on the CURRENT form inputs (not just on the
  // cached priceInfo) — keepPreviousData keeps the last result alive after the
  // dialog is cancelled, so without this the note lingers on a fresh empty form.
  const hasPriceInputs = priceableType && form.IDreference > 0 && Number(form.quantite) > 0
  // The client is part of the price: its tarif mode on this (référence × coloris)
  // may be a negotiated contract or a fixed coefficient rather than the standard
  // grid. It also decides whether the line is sellable at all — hence the query
  // runs as soon as a reference is picked, WITHOUT waiting for a quantity, so an
  // expired contract is announced before the user types anything.
  const { data: priceInfo, isPlaceholderData: priceIsStale } = useQuery<LinePriceInfo>({
    queryKey: ['cc-line-price', commande.IDclient, form.type, form.IDreference, form.IDcolori, debouncedQuantite, form.unite],
    queryFn: () => apiFetch(
      `/commandes-client/lookups/line-price?type=${form.type}&ref=${form.IDreference}&coloris=${form.IDcolori}`
      + `&quantite=${encodeURIComponent(debouncedQuantite)}&unite=${form.unite}&client=${commande.IDclient}`,
    ),
    enabled: open && priceableType && form.IDreference > 0,
    // Keep the previous note/price visible while the next quantity recomputes, so
    // the dialog doesn't collapse-and-reflow vertically on every keystroke.
    placeholderData: keepPreviousData,
  })
  // Never block a save (or flash the red banner) on the PREVIOUS reference's
  // answer: keepPreviousData keeps it alive until the new one lands.
  const contratExpire = !priceIsStale && !!priceInfo?.blocked && priceableType && form.IDreference > 0
  // An existing line taken while the contract was still valid stays editable for
  // its date or its comment — only a commercial change (référence, coloris,
  // quantité, prix) is refused. Mirrors the API's own PUT guard.
  const commercialChanged = isNew || !line
    || form.type !== line.type
    || form.IDreference !== line.IDreference
    || form.IDcolori !== line.IDcolori
    || (Number(form.quantite) || 0) !== (Number(line.quantite) || 0)
    || Math.round((Number(form.prix) || 0) * 100) !== Math.round((Number(line.prix) || 0) * 100)
  const contratBlocksSave = contratExpire && commercialChanged

  // When locked and the tariff produced a price, push it into the form.
  useEffect(() => {
    if (!priceLocked) return
    if (priceInfo?.priceable && priceInfo.prix != null) {
      const next = String(priceInfo.prix)
      setForm((f) => (f.prix === next ? f : { ...f, prix: next }))
    }
  }, [priceLocked, priceInfo])

  // Price input is read-only while the tariff is actively driving it, and for
  // tariff-priced types whenever the user lacks the déverrouiller permission.
  const autoPriceActive = priceLocked && priceableType && !!priceInfo?.priceable && priceInfo.prix != null
  const priceReadOnly = autoPriceActive || (priceableType && !canUnlockPrice)

  // Reference lookups per type. Écru/fini are restricted to the references
  // assigned to this client in designation_client (the buyable catalogue);
  // divers are generic and stay unrestricted.
  const { data: refsEcru } = useQuery<RefEcru[]>({ queryKey: ['cc-refs-ecru', commande.IDclient], queryFn: () => apiFetch(`/commandes-client/lookups/refs-ecru?client=${commande.IDclient}`), enabled: open && form.type === 1 })
  const { data: refsFini } = useQuery<RefFini[]>({ queryKey: ['cc-refs-fini', commande.IDclient], queryFn: () => apiFetch(`/commandes-client/lookups/refs-fini?client=${commande.IDclient}`), enabled: open && form.type === 2 })
  // Divers refs come from the shared expéditions lookup — it's the only one
  // that exposes the sTypeVariation1/2 axis labels the variation pickers need.
  const { data: refsDivers } = useQuery<RefDivers[]>({
    queryKey: ['exp-divers-refs'],
    queryFn: () => apiFetch('/expeditions/divers/lookups/refs'),
    enabled: open && form.type === 3,
    staleTime: 5 * 60 * 1000,
  })
  const selRefDivers = (refsDivers ?? []).find((r) => r.IDref_divers === form.IDreference) ?? null
  const { data: diversVariations } = useQuery<RefDiversVariation[]>({
    queryKey: ['exp-divers-vars', form.IDreference],
    queryFn: () => apiFetch(`/expeditions/divers/lookups/refs/${form.IDreference}/variations`),
    enabled: open && form.type === 3 && form.IDreference > 0,
    staleTime: 5 * 60 * 1000,
  })
  // niveau 1 ↔ sTypeVariation1 axis (0 = pre-axis legacy rows), niveau 2 ↔ axis 2.
  const diversVars1 = (diversVariations ?? []).filter((v) => v.niveau <= 1)
  const diversVars2 = (diversVariations ?? []).filter((v) => v.niveau === 2)

  // tarif_divers grid price for the exact (ref, v1, v2) combo — the endpoint
  // falls back (v1,0) → (0,0) → ref_divers.prix_unitaire, and returns 0 when the
  // reference has no tariff at all, which leaves the field free for manual entry.
  const { data: diversPrix } = useQuery<{ prix: number }>({
    queryKey: ['exp-divers-prix', form.IDreference, form.IDVariation1, form.IDVariation2],
    queryFn: () => apiFetch(
      `/expeditions/divers/lookups/prix?ref=${form.IDreference}&v1=${form.IDVariation1}&v2=${form.IDVariation2}`,
    ),
    enabled: open && form.type === 3 && form.IDreference > 0,
  })
  useEffect(() => {
    if (!open || form.type !== 3 || diversPrixTouched || !diversPrix) return
    const next = diversPrix.prix > 0 ? String(diversPrix.prix) : ''
    setForm((f) => (f.prix === next ? f : { ...f, prix: next }))
  }, [open, form.type, diversPrixTouched, diversPrix])

  // Coloris lookup for the selected ref (écru/fini only), narrowed to the
  // coloris THIS client buys on that reference (Clients › Gestion). A reference
  // can carry hundreds of coloris dyed for other customers — offering them all
  // is how a line ends up on a colour the client never ordered. `current` keeps
  // an existing line's coloris in the list even when it predates the catalogue.
  const currentColori = line?.IDcolori ?? 0
  const { data: coloriOptions } = useQuery<ColoriOption[]>({
    queryKey: ['cc-coloris', commande.IDclient, form.type, form.IDreference, currentColori],
    queryFn: async () => {
      const scope = `&client=${commande.IDclient}&current=${currentColori}`
      if (form.type === 1) {
        const rows = await apiFetch<{ IDcolori_ecru: number; reference: string; hors_catalogue?: boolean }[]>(
          `/commandes-client/lookups/colori-ecru?ref_ecru=${form.IDreference}${scope}`,
        )
        return rows.map((r) => ({ id: r.IDcolori_ecru, reference: r.reference, hors_catalogue: r.hors_catalogue }))
      }
      return apiFetch<ColoriOption[]>(`/commandes-client/lookups/colori-fini?ref_fini=${form.IDreference}${scope}`)
    },
    enabled: open && form.IDreference > 0 && (form.type === 1 || form.type === 2),
  })
  // Every option flagged = the client has no coloris registered on this ref, so
  // the full list is shown as a fallback rather than an empty picker.
  const coloriCatalogueVide = (coloriOptions ?? []).length > 0 && (coloriOptions ?? []).every((c) => c.hors_catalogue)

  const saveMut = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        type: form.type,
        IDreference: form.IDreference,
        IDcolori: form.IDcolori,
        IDVariation1: form.type === 3 ? form.IDVariation1 : 0,
        IDVariation2: form.type === 3 ? form.IDVariation2 : 0,
        quantite: Number(form.quantite) || 0,
        unite: form.unite,
        prix: Number(form.prix) || 0,
        date_livraison: form.date_livraison ? inputDateToHfsql(form.date_livraison) : '',
        commentaire: form.commentaire,
      })
      return isNew
        ? apiFetch(`/commandes-client/${commande.IDcommande_client}/lignes`, { method: 'POST', body })
        : apiFetch(`/commandes-client/lignes/${line!.IDligne_commande_client}`, { method: 'PUT', body })
    },
    onSuccess,
    onError: (e: unknown) => {
      // 409 = the API's own contract guard (a stale form, or the contract
      // lapsed between opening the dialog and saving). apiFetch doesn't carry
      // the server's message, so restate it here.
      const status = (e as { status?: number } | null)?.status
      if (status === 409) {
        setError(priceInfo?.blocked_reason
          ?? 'Contrat expiré — cette référence n’est plus disponible tant qu’un nouveau contrat n’a pas été établi.')
        return
      }
      setError(e instanceof Error ? e.message : 'Erreur')
    },
  })

  const refOptions = form.type === 1
    ? (refsEcru ?? []).map((r) => ({ id: r.IDref_ecru, primary: r.reference }))
    : form.type === 2
      ? (refsFini ?? []).map((r) => ({ id: r.IDref_fini, primary: r.reference, secondary: r.designation }))
      // Archived divers refs stay hidden, except the one an existing line points at.
      : (refsDivers ?? [])
        .filter((r) => !r.archive || r.IDref_divers === (line?.IDreference ?? 0))
        .map((r) => ({ id: r.IDref_divers, primary: r.designation, secondary: r.unite_label || undefined }))

  const setType = (t: number) => {
    setDiversPrixTouched(false)
    setForm({ ...form, type: t, IDreference: 0, IDcolori: 0, IDVariation1: 0, IDVariation2: 0, unite: t === 1 ? 1 : t === 3 ? 4 : 3 })
  }

  // An expired contract makes the reference unsellable — same rule as the fiche
  // client, enforced again on the API (409 contrat_expire).
  const canSave = form.IDreference > 0 && Number(form.quantite) > 0 && !contratBlocksSave

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
          {/* Type toggle */}
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
              onChange={(id) => {
                setDiversPrixTouched(false) // new combo → re-resolve the grid price
                setForm({ ...form, IDreference: id, IDcolori: 0, IDVariation1: 0, IDVariation2: 0 })
              }}
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
                options={(coloriOptions ?? []).map((c) => ({
                  id: c.id,
                  primary: c.reference,
                  secondary: c.hors_catalogue && !coloriCatalogueVide ? 'hors catalogue' : undefined,
                }))}
                value={form.IDcolori}
                onChange={(id) => setForm({ ...form, IDcolori: id })}
                disabled={!form.IDreference}
                emptyLabel="— Choisir —"
              />
              {coloriCatalogueVide && (
                <p className="text-[11px] text-muted-foreground italic">
                  Aucun coloris enregistré pour ce client sur cette référence — liste complète affichée.
                </p>
              )}
            </div>
          )}
          {/* Expired contract: the negotiated prices are gone and the reference
              is not sellable until a new contract is signed. Never a silent
              fall back to the standard grid — that is exactly how an order left
              at the catalogue price a month after the contract lapsed. */}
          {contratExpire && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-500/25 bg-red-500/10 text-red-700 text-xs font-medium">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>
                {priceInfo?.blocked_reason}
                {!isNew && !commercialChanged && (
                  <> La ligne existante reste modifiable pour sa date et son commentaire.</>
                )}
              </span>
            </div>
          )}
          {/* Which grid priced this line — silence for the standard one, since
              that is the default the user already assumes. */}
          {!contratExpire && !priceIsStale && priceInfo?.tarif_mode === 'contrat' && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <FileSignature className="h-3.5 w-3.5 flex-shrink-0" />
              Prix contrat client{priceInfo.contrat_date_expiration ? ` — jusqu’au ${formatHfsqlDate(priceInfo.contrat_date_expiration)}` : ''}
            </p>
          )}
          {!contratExpire && !priceIsStale && priceInfo?.tarif_mode === 'coefficient' && priceInfo.coefficient > 0 && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-sky-700">
              <Percent className="h-3.5 w-3.5 flex-shrink-0" />
              Tarif client — coefficient {priceInfo.coefficient} %
            </p>
          )}
          {/* Divers: the two variation axes narrow the catalog ref down to the
              exact article shipped — they key both the stock ledger and the
              expedition items, so a line without them can't be shipped. */}
          {form.type === 3 && form.IDreference > 0 && diversVars1.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {selRefDivers && selRefDivers.sTypeVariation1 !== 'Aucun' ? selRefDivers.sTypeVariation1 : 'Variation'}
              </label>
              <PopoverSelect
                options={diversVars1.map((v) => ({ id: v.IDref_divers_variation, primary: v.designation }))}
                value={form.IDVariation1}
                onChange={(id) => { setDiversPrixTouched(false); setForm({ ...form, IDVariation1: id }) }}
                emptyLabel="— aucune —"
              />
            </div>
          )}
          {form.type === 3 && form.IDreference > 0 && diversVars2.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {selRefDivers && selRefDivers.sTypeVariation2 !== 'Aucun' ? selRefDivers.sTypeVariation2 : 'Variation 2'}
              </label>
              <PopoverSelect
                options={diversVars2.map((v) => ({ id: v.IDref_divers_variation, primary: v.designation }))}
                value={form.IDVariation2}
                onChange={(id) => { setDiversPrixTouched(false); setForm({ ...form, IDVariation2: id }) }}
                emptyLabel="— aucune —"
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
                options={[{ id: 1, primary: 'Kg' }, { id: 3, primary: 'Ml' }, { id: 4, primary: 'unité' }, { id: 5, primary: 'm²' }]}
                value={form.unite}
                onChange={(id) => setForm({ ...form, unite: id })}
                hideEmpty
              />
            </div>
            <div className="col-span-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Prix (€)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={form.prix}
                  onChange={(e) => {
                    if (form.type === 3) setDiversPrixTouched(true) // stop auto-filling from the grid
                    setForm({ ...form, prix: e.target.value })
                  }}
                  readOnly={priceReadOnly}
                  className={cn(inputClass, priceReadOnly && 'bg-zinc-100 text-muted-foreground cursor-not-allowed')}
                />
                {priceableType && canUnlockPrice && (
                  <button
                    type="button"
                    onClick={() => setPriceLocked((v) => !v)}
                    title={priceLocked ? 'Déverrouiller le prix (saisie manuelle)' : 'Verrouiller le prix (calcul automatique)'}
                    className={cn(
                      'flex-shrink-0 h-8 w-8 rounded-md border flex items-center justify-center transition-colors',
                      priceLocked ? 'border-accent/40 text-accent bg-accent/5 hover:bg-accent/10' : 'border-input text-muted-foreground hover:bg-zinc-100',
                    )}
                  >
                    {priceLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* Roll-count note (green when the quantity is a whole-roll multiple,
              amber when it overshoots a clean roll count). */}
          {hasPriceInputs && priceInfo?.priceable && (() => {
            const { nRolls, exact, cleanQty, unite_label } = priceInfo
            if (nRolls < 1) {
              return (
                <p className="text-xs font-medium text-amber-600 -mt-1">
                  Métrage — moins d’un rouleau
                </p>
              )
            }
            return (
              <p className={cn('text-xs font-medium -mt-1', exact ? 'text-green-600' : 'text-amber-600')}>
                {exact ? '' : '> '}{nRolls} Rouleau{nRolls > 1 ? 'x' : ''} ({fmtNum(cleanQty)} {unite_label})
              </p>
            )
          })()}
          {/* Commercial nudge: within 15% of the next (cheaper) tariff tranche —
              Tricobot suggests the employee propose the round-up to the customer. */}
          {hasPriceInputs && priceInfo?.priceable && !priceInfo.exact && priceInfo.nearNextTranche && priceInfo.nextTranchePrix != null && (() => {
            const saving = priceInfo.prix && priceInfo.prix > 0
              ? Math.round(((priceInfo.prix - priceInfo.nextTranchePrix!) / priceInfo.prix) * 100)
              : 0
            return (
              <div className="flex items-end gap-2 -mt-1">
                <img
                  src="/tricobot/tricobot-wave.png"
                  alt="Tricobot"
                  className="h-14 w-14 flex-shrink-0 object-contain"
                  draggable={false}
                />
                {/* Speech bubble — tail points at Tricobot */}
                <div className="relative flex-1 rounded-md border border-gold/50 bg-gold/10 px-2.5 py-2">
                  <div className="absolute -left-[5px] bottom-4 h-2.5 w-2.5 rotate-45 border-l border-b border-gold/50 bg-gold/10" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-0.5 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />Tricobot
                  </p>
                  <p className="text-xs text-amber-900 leading-snug">
                    Plus que <b>{fmtNum(priceInfo.nextTrancheGapQty)} {priceInfo.unite_label}</b> pour atteindre{' '}
                    <b>{priceInfo.nextTrancheRolls} rouleaux</b> et passer à{' '}
                    <b>{fmtNum(priceInfo.nextTranchePrix!, 2)} €</b>/{priceInfo.unite_label}
                    {saving > 0 ? <> (<b>−{saving}%</b>)</> : null}.{' '}
                    <span className="text-amber-700">À proposer au client&nbsp;?</span>
                  </p>
                </div>
              </div>
            )
          })()}
          <LabeledInput label="Date d'expédition" type="date" value={form.date_livraison} onChange={(v) => setForm({ ...form, date_livraison: v })} />
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
  commande, isLoading, isEditing,
  editDateCommande, onEditDateCommandeChange,
  editRefClient, onEditRefClientChange,
  editCommentaire, onEditCommentaireChange,
  editCommentaireInterne, onEditCommentaireInterneChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editRemise, onEditRemiseChange,
  editFraisPort, onEditFraisPortChange,
  editDonation, onEditDonationChange,
  editIDAdresseFacturation, onEditIDAdresseFacturationChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
  onToggleEtat, isTogglingEtat,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  isEditing: boolean
  editDateCommande: string; onEditDateCommandeChange: (v: string) => void
  editRefClient: string; onEditRefClientChange: (v: string) => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
  editCommentaireInterne: string; onEditCommentaireInterneChange: (v: string) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editRemise: string; onEditRemiseChange: (v: string) => void
  editFraisPort: string; onEditFraisPortChange: (v: string) => void
  editDonation: boolean; onEditDonationChange: (v: boolean) => void
  editIDAdresseFacturation: number; onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number; onEditIDAdresseLivraisonChange: (v: number) => void
  onToggleEtat: () => void
  isTogglingEtat: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')

  // These two enum lookups are also needed in VIEW mode to resolve the
  // IDmode_paiement / IDecheance labels (InfoTab). They're tiny + static, so load
  // them unconditionally — gating on isEditing left view mode showing "—" until the
  // user opened the editor (which is when the lookups were first fetched).
  const { data: modesPaiement } = useQuery<ModePaiement[]>({
    queryKey: ['cc-modes-paiement'],
    queryFn: () => apiFetch('/commandes-client/lookups/modes-paiement'),
  })
  const { data: echeances } = useQuery<Echeance[]>({
    queryKey: ['cc-echeances'],
    queryFn: () => apiFetch('/commandes-client/lookups/echeances'),
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['cc-adresses', commande?.IDclient],
    queryFn: () => apiFetch(`/commandes-client/lookups/adresses?client=${commande?.IDclient}`),
    enabled: isEditing && !!commande?.IDclient,
  })

  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2">{[1, 2, 3].map((i) => <div key={i} className="h-8 flex-1 bg-muted animate-pulse rounded-md" />)}</div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!commande) return null

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
              commande={commande} isEditing={isEditing}
              modesPaiement={modesPaiement ?? []} echeances={echeances ?? []}
              editDateCommande={editDateCommande} onEditDateCommandeChange={onEditDateCommandeChange}
              editRefClient={editRefClient} onEditRefClientChange={onEditRefClientChange}
              editCommentaire={editCommentaire} onEditCommentaireChange={onEditCommentaireChange}
              editCommentaireInterne={editCommentaireInterne} onEditCommentaireInterneChange={onEditCommentaireInterneChange}
              editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={onEditIDModePaiementChange}
              editIDEcheance={editIDEcheance} onEditIDEcheanceChange={onEditIDEcheanceChange}
              editRemise={editRemise} onEditRemiseChange={onEditRemiseChange}
              editFraisPort={editFraisPort} onEditFraisPortChange={onEditFraisPortChange}
              editDonation={editDonation} onEditDonationChange={onEditDonationChange}
            />
          )}
          {activeTab === 'adresses' && (
            <AdressesTab
              commande={commande} isEditing={isEditing} adresses={adresses ?? []}
              editIDAdresseFacturation={editIDAdresseFacturation} onEditIDAdresseFacturationChange={onEditIDAdresseFacturationChange}
              editIDAdresseLivraison={editIDAdresseLivraison} onEditIDAdresseLivraisonChange={onEditIDAdresseLivraisonChange}
            />
          )}
          {activeTab === 'docs' && <DocsTab commande={commande} isEditing={isEditing} />}
          {activeTab === 'historique' && <HistoriqueTab commandeId={commande.IDcommande_client} />}
        </div>
      </div>
      <StatusFooter etat={commande.est_soldee} onToggle={onToggleEtat} isToggling={isTogglingEtat} disabled={isEditing} />
    </div>
  )
}

function StatusFooter({ etat, onToggle, isToggling, disabled }: { etat: number; onToggle: () => void; isToggling: boolean; disabled: boolean }) {
  // Closing/reopening is permission-gated — without it the pill is display-only.
  const canCloture = useHasPermission('cloture_commande_client')
  const isTerminee = etat === 1
  const Icon = isTerminee ? CheckCircle2 : Clock
  const label = isTerminee ? 'Terminée' : 'En cours'
  const actionLabel = isTerminee ? 'Rouvrir' : 'Clôturer'
  const ActionIcon = isTerminee ? Clock : CheckCircle2
  return (
    <div className={cn('flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', isTerminee ? 'bg-success border-success' : 'bg-primary border-primary')}>
      <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm font-bold uppercase tracking-wide truncate">{label}</span>
      </div>
      {canCloture && (
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled || isToggling}
          title={isTerminee ? 'Marquer en cours' : 'Marquer terminée'}
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          <ActionIcon className="h-3.5 w-3.5" />{actionLabel}
        </button>
      )}
    </div>
  )
}

// ── Sidebar Tab: Info ──────────────────────────────────

function InfoTab({
  commande, isEditing, modesPaiement, echeances,
  editDateCommande, onEditDateCommandeChange,
  editRefClient, onEditRefClientChange,
  editCommentaire, onEditCommentaireChange,
  editCommentaireInterne, onEditCommentaireInterneChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editRemise, onEditRemiseChange,
  editFraisPort, onEditFraisPortChange,
  editDonation, onEditDonationChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  modesPaiement: ModePaiement[]
  echeances: Echeance[]
  editDateCommande: string; onEditDateCommandeChange: (v: string) => void
  editRefClient: string; onEditRefClientChange: (v: string) => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
  editCommentaireInterne: string; onEditCommentaireInterneChange: (v: string) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editRemise: string; onEditRemiseChange: (v: string) => void
  editFraisPort: string; onEditFraisPortChange: (v: string) => void
  editDonation: boolean; onEditDonationChange: (v: boolean) => void
}) {
  const canMarkDonation = useHasPermission('donation_commande_client')
  const modeLabel = modesPaiement.find((m) => m.IDmode_paiement === commande.IDmode_paiement)?.libelle
  const echeanceLabel = echeances.find((e) => e.IDecheance === commande.IDecheance)?.libelle
  const smallInput = 'h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[120px]'
  return (
    <div className="space-y-3">
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
        <KV label="Client" value={commande.client_nom || '—'} />
        <KV label="Date commande" value={isEditing ? (
          <input type="date" value={editDateCommande} onChange={(e) => onEditDateCommandeChange(e.target.value)}
            className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right" />
        ) : (commande.date_commande ? formatHfsqlDate(commande.date_commande) : '—')} />
        {/* Réf. client carries long free text ("Commande 0006293 du 06/11/2025")
            — in edit mode the input flexes to all the width left of the label
            instead of the narrow fixed KV value slot. */}
        {isEditing ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground flex-shrink-0">Réf. client</span>
            <input type="text" value={editRefClient} onChange={(e) => onEditRefClientChange(e.target.value)}
              className="flex-1 min-w-0 h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right" />
          </div>
        ) : (
          <KV label="Réf. client" value={commande.ref_client || '—'} />
        )}
        <KV label="Mode paiement" value={isEditing ? (
          <PopoverSelect size="sm" options={modesPaiement.map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))}
            value={editIDModePaiement} onChange={onEditIDModePaiementChange} emptyLabel="—" />
        ) : (modeLabel || '—')} />
        <KV label="Échéance" value={isEditing ? (
          <PopoverSelect size="sm" options={echeances.map((e) => ({ id: e.IDecheance, primary: e.libelle }))}
            value={editIDEcheance} onChange={onEditIDEcheanceChange} emptyLabel="—" />
        ) : (echeanceLabel || '—')} />
        <KV label="Remise (€)" value={isEditing ? (
          <input type="number" value={editRemise} onChange={(e) => onEditRemiseChange(e.target.value)} className={smallInput} />
        ) : (commande.remise ? fmtNum(commande.remise, 2) : '—')} />
        <KV label="Frais de port (€)" value={isEditing ? (
          <input type="number" value={editFraisPort} onChange={(e) => onEditFraisPortChange(e.target.value)} className={smallInput} />
        ) : (commande.frais_port ? fmtNum(commande.frais_port, 2) : '—')} />
        {/* Donation — material shipped from this order must never generate a
            proforma; the flag propagates to expeditions created from it.
            Visible only with the donation_commande_client permission.
            The flag rewires the whole order model (lignes ↔ donation pieces):
            on a normal commande the toggle disappears entirely as soon as a
            ligne exists (it comes back when they're all deleted); on a
            donation commande it stays visible but locks while stock pieces
            are still attached. Mirrors the API 409 guards. */}
        {canMarkDonation && (commande.donation === 1 || commande.lignes.length === 0) && (() => {
          const donationLocked = commande.donation === 1 && commande.nb_donation_pieces > 0
          return (
            <div className="pt-1">
              <TogglePill label="Donation" checked={isEditing ? editDonation : !!commande.donation}
                disabled={!isEditing || donationLocked} onChange={onEditDonationChange} />
              {isEditing && donationLocked && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Retirez d’abord les pièces en donation pour pouvoir désactiver.
                </p>
              )}
            </div>
          )
        })()}
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Commentaire
        </p>
        {isEditing ? (
          <textarea value={editCommentaire} onChange={(e) => onEditCommentaireChange(e.target.value)} rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : commande.commentaire?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{commande.commentaire.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
        )}
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Journal
        </p>
        {isEditing ? (
          <textarea value={editCommentaireInterne} onChange={(e) => onEditCommentaireInterneChange(e.target.value)} rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : commande.commentaire_interne?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{commande.commentaire_interne.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Journal vide</p>
        )}
      </div>

      {commande.tombe_metier.length > 0 && (
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <TmRollIcon className="h-3.5 w-3.5" />Tombé de métier commandé
          </p>
          <div className="space-y-1.5">
            {commande.tombe_metier.map((t) => (
              <div key={`${t.IDref_ecru}|${t.coloris_label}`} className="flex items-center justify-between gap-2">
                <span className="text-sm">{t.ref_label}{t.coloris_label ? ` /${t.coloris_label}` : ''}</span>
                <span className="text-sm font-semibold tabular-nums text-accent">{fmtNum(t.poids_kg, 1)} kg</span>
              </div>
            ))}
            {commande.tombe_metier.length > 1 && (
              <div className="flex items-center justify-between gap-2 pt-1.5 mt-0.5 border-t border-border/60">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Total</span>
                <span className="text-sm font-bold tabular-nums">
                  {fmtNum(commande.tombe_metier.reduce((s, t) => s + t.poids_kg, 0), 1)} kg
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fiche client — customer-specific handling notes (client.commentaire),
          read-only here; edited from Clients › Gestion. */}
      {!!commande.client_fiche && (
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />Fiche client
          </p>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{commande.client_fiche}</p>
        </div>
      )}
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
  editIDAdresseFacturation: number; onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number; onEditIDAdresseLivraisonChange: (v: number) => void
}) {
  return (
    <div className="space-y-3">
      <AdresseCard label="Facturation" adresse={commande.adresse_facturation} isEditing={isEditing}
        options={adresses} selectedId={editIDAdresseFacturation} onSelect={onEditIDAdresseFacturationChange} />
      <AdresseCard label="Livraison" adresse={commande.adresse_livraison} isEditing={isEditing}
        options={adresses} selectedId={editIDAdresseLivraison} onSelect={onEditIDAdresseLivraisonChange} />
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
interface TypeDoc { IDtype_doc: number; nom: string }

// A facture from the facturation ledger auto-discovered via the expedition
// chain (commande → expedition → ligne_expedition → ligne_facture).
interface CommandeFactureRow {
  kind: 'def' | 'prov'
  id: number
  numero: number | null
  date: string | null
  type: number // 1 = facture, 2 = avoir
}

function factureLabel(f: CommandeFactureRow): string {
  const word = f.kind === 'prov' ? 'Proforma' : f.type === 2 ? 'Avoir' : 'Facture'
  return `${word} N°${f.numero ?? f.id}`
}

function DocsTab({ commande, isEditing }: { commande: CommandeDetail; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const commandeId = commande.IDcommande_client
  const docsQueryKey = ['commande-client-docs', commandeId] as const

  const { data, isLoading, error } = useQuery<GedDocument[]>({
    queryKey: docsQueryKey,
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/documents`),
  })
  const { data: factures } = useQuery<CommandeFactureRow[]>({
    queryKey: ['commande-client-factures', commandeId],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/factures`),
  })

  const [viewFacture, setViewFacture] = useState<CommandeFactureRow | null>(null)
  const [viewDoc, setViewDoc] = useState<GedDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<GedDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<GedDocument | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: docsQueryKey })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, commandeId])

  const deleteMut = useMutation({
    mutationFn: (idged: number) => apiFetch(`/commandes-client/${commandeId}/documents/${idged}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  return (
    <>
      {isLoading && <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>}
      {!!error && (
        <div className="flex items-center gap-1.5 py-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /><span>Erreur de chargement</span></div>
      )}
      {!isLoading && !error && !data?.length && !factures?.length && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">Aucun document</p>
          <p className="text-[11px] mt-1 text-center">Les factures, bons de commande, confirmations et autres documents liés à cette commande apparaîtront ici.</p>
        </div>
      )}
      {!!factures?.length && (
        <div className="space-y-2">
          {factures.map((f) => (
            <div
              key={`${f.kind}-${f.id}`}
              onClick={() => setViewFacture(f)}
              className="group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-accent/10"><ReceiptText className="h-3.5 w-3.5 text-accent" /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{factureLabel(f)}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {f.kind === 'prov' ? 'Facture proforma' : f.type === 2 ? 'Avoir' : 'Facture définitive'}
                    {f.date && f.date.length === 8 ? ` · ${formatHfsqlDate(f.date)}` : ''}
                  </p>
                </div>
              </div>
            </div>
          ))}
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

      <FactureViewDialog facture={viewFacture} onClose={() => setViewFacture(null)} />
      <DocViewDialog commandeId={commandeId} doc={viewDoc} onClose={() => setViewDoc(null)} />
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
        onConfirm={() => { if (deleteDocConfirm) deleteMut.mutate(deleteDocConfirm.IDged, { onSuccess: () => setDeleteDocConfirm(null) }) }}
      />
    </>
  )
}

function DocCreateEditDialog({
  open, commandeId, doc, onClose, onSuccess,
}: {
  open: boolean
  commandeId: number
  doc: GedDocument | null
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = doc === null
  const [nom, setNom] = useState('')
  const [idTypeDoc, setIdTypeDoc] = useState(0)
  const [commentaire, setCommentaire] = useState('')
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: typeDocs } = useQuery<TypeDoc[]>({
    queryKey: ['cc-types-doc'],
    queryFn: () => apiFetch('/commandes-client/lookups/type-doc'),
    enabled: open,
  })

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
      formData.append('IDtype_doc', String(idTypeDoc))
      if (newFile) formData.append('fichier', newFile)
      if (removeFichier && !newFile) formData.append('remove_fichier', '1')
      const url = isNew
        ? `${API_URL}/commandes-client/${commandeId}/documents`
        : `${API_URL}/commandes-client/${commandeId}/documents/${doc!.IDged}`
      const res = await fetch(url, { method: isNew ? 'POST' : 'PUT', body: formData, credentials: 'include' })
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)
      onSuccess()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue'); setIsSaving(false)
    }
  }

  const previewUrl = newFileUrl ? newFileUrl
    : !isNew && !removeFichier && doc ? `${API_URL}/commandes-client/${commandeId}/documents/${doc.IDged}/fichier#view=FitH` : null

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
              <label className="text-xs font-medium text-muted-foreground">Type de document</label>
              <PopoverSelect options={(typeDocs ?? []).map((t) => ({ id: t.IDtype_doc, primary: t.nom }))}
                value={idTypeDoc} onChange={setIdTypeDoc} emptyLabel="— Aucun —" />
            </div>
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

function DocViewDialog({ commandeId, doc, onClose }: { commandeId: number; doc: GedDocument | null; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (!doc) { setFichierOk(null); return }
    setFichierOk(null)
    fetch(`${API_URL}/commandes-client/${commandeId}/documents/${doc.IDged}/fichier`, { method: 'HEAD', credentials: 'include' })
      .then((r) => setFichierOk(r.ok)).catch(() => setFichierOk(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.IDged, commandeId])
  if (!doc) return null
  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe src={`${API_URL}/commandes-client/${commandeId}/documents/${doc.IDged}/fichier#view=FitH`} className="w-full h-full rounded-lg" title={doc.nom ?? 'Document'} />
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

// Chrome-free viewer for an auto-discovered facture — the PDF is rendered on
// the fly by the facturation API, so no HEAD pre-check is needed.
function FactureViewDialog({ facture, onClose }: { facture: CommandeFactureRow | null; onClose: () => void }) {
  if (!facture) return null
  return (
    <Dialog open={!!facture} onOpenChange={() => onClose()}>
      <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={`${API_URL}/factures/${facture.kind}/${facture.id}/pdf#view=FitH`}
          className="w-full h-full rounded-lg"
          title={factureLabel(facture)}
        />
      </div>
    </Dialog>
  )
}

// ── Sidebar Tab: Historique ────────────────────────────

// kind 'legacy' = commande_client.envoyé_client flag set by the WinDev app —
// no date and no recipients are recorded there, only the fact it was sent.
interface HistoriqueEvent { kind: 'email' | 'legacy'; type_label: string; recipients: string[]; DATE: string }

function HistoriqueTab({ commandeId }: { commandeId: number }) {
  const { data, isLoading, error } = useQuery<HistoriqueEvent[]>({
    queryKey: ['commande-client-historique', commandeId],
    queryFn: () => apiFetch(`/commandes-client/${commandeId}/historique`),
  })
  if (isLoading) return <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
  if (error) return <div className="flex items-center gap-1.5 py-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /><span>Erreur de chargement</span></div>
  if (!data?.length) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <History className="h-10 w-10 mb-3 opacity-40" />
      <p className="text-sm font-medium">Aucun évènement</p>
      <p className="text-[11px] mt-1 text-center">Les envois d'emails liés à cette commande apparaîtront ici.</p>
    </div>
  )
  return (
    <div className="space-y-2">
      {data.map((ev, i) => (
        <div key={i} className="p-3 rounded-lg border bg-card shadow-sm">
          <div className="flex items-center gap-2">
            <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', ev.kind === 'legacy' ? 'bg-muted' : 'bg-accent/10')}>
              <AtSign className={cn('h-3.5 w-3.5', ev.kind === 'legacy' ? 'text-muted-foreground' : 'text-accent')} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{ev.type_label}</p>
              <p className={cn('text-[11px] text-muted-foreground', ev.kind === 'legacy' && 'italic')}>
                {ev.kind === 'legacy' ? 'Envoyée depuis l\'ancienne application' : ev.DATE ? formatDateTime(ev.DATE) : ''}
              </p>
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
  // envoi_email.DATE is "YYYY-MM-DD HH:MM:SS.sss"
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`
}

// ── Create Dialog ──────────────────────────────────────

function CreateCommandeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (newId: number) => void }) {
  const [clientId, setClientId] = useState(0)
  const [dateCommande, setDateCommande] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [refClient, setRefClient] = useState('')
  const [modePaiementId, setModePaiementId] = useState(0)
  const [echeanceId, setEcheanceId] = useState(0)
  const [adresseFactId, setAdresseFactId] = useState(0)
  const [adresseLivId, setAdresseLivId] = useState(0)

  const { data: clients } = useQuery<ClientLite[]>({ queryKey: ['cc-clients'], queryFn: () => apiFetch('/commandes-client/lookups/clients'), enabled: open })
  const { data: modesPaiement } = useQuery<ModePaiement[]>({ queryKey: ['cc-modes-paiement'], queryFn: () => apiFetch('/commandes-client/lookups/modes-paiement'), enabled: open })
  const { data: echeances } = useQuery<Echeance[]>({ queryKey: ['cc-echeances'], queryFn: () => apiFetch('/commandes-client/lookups/echeances'), enabled: open })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['cc-create-adresses', clientId],
    queryFn: () => apiFetch(`/commandes-client/lookups/adresses?client=${clientId}`),
    enabled: open && clientId > 0,
  })

  useEffect(() => {
    if (!adresses) return
    const defaultFact = adresses.find((a) => a.est_defaut_facturation) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    const defaultLiv = adresses.find((a) => a.est_defaut_livraison) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    setAdresseFactId(defaultFact?.IDadresse ?? 0)
    setAdresseLivId(defaultLiv?.IDadresse ?? 0)
  }, [adresses])

  // Prefill payment fields from the selected client's sheet (client.IDmode_paiement
  // / IDecheance). Keyed on clientId so re-picking a client re-applies its defaults.
  useEffect(() => {
    if (clientId <= 0 || !clients) return
    const c = clients.find((x) => x.IDclient === clientId)
    if (!c) return
    setModePaiementId(c.IDmode_paiement ?? 0)
    setEcheanceId(c.IDecheance ?? 0)
  }, [clientId, clients])

  useEffect(() => {
    if (!open) {
      setClientId(0); setDateCommande(new Date().toISOString().slice(0, 10)); setRefClient('')
      setModePaiementId(0); setEcheanceId(0); setAdresseFactId(0); setAdresseLivId(0)
    }
  }, [open])

  const createMut = useMutation({
    mutationFn: () => apiFetch('/commandes-client', {
      method: 'POST',
      body: JSON.stringify({
        IDclient: clientId,
        date_commande: inputDateToHfsql(dateCommande),
        ref_client: refClient,
        IDmode_paiement: modePaiementId || 0,
        IDecheance: echeanceId || 0,
        IDadresse_facturation: adresseFactId || 0,
        IDadresse_livraison: adresseLivId || 0,
      }),
    }),
    onSuccess: (data: { IDcommande_client: number }) => onCreated(data.IDcommande_client),
  })

  const canSave = clientId > 0 && dateCommande.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-accent" />Nouvelle commande</DialogTitle>
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
              <label className="text-xs font-medium text-muted-foreground">Date commande</label>
              <input type="date" value={dateCommande} onChange={(e) => setDateCommande(e.target.value)} className={cn(inputClass, 'h-9')} />
            </div>
            <LabeledInput label="Réf. client" value={refClient} onChange={setRefClient} />
          </div>
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
                <PopoverSelect options={(adresses ?? []).map(adresseOption)} value={adresseFactId} onChange={setAdresseFactId} emptyLabel="—" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Adr. livraison</label>
                <PopoverSelect options={(adresses ?? []).map(adresseOption)} value={adresseLivId} onChange={setAdresseLivId} emptyLabel="—" />
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

// Same inline switch as the "Client interne" toggle in ClientsGestion.tsx.
function TogglePill({ label, checked, disabled, onChange }: {
  label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/60 bg-white shadow-sm">
      <span className="text-xs font-medium">{label}</span>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          checked ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80')}>
        <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
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
