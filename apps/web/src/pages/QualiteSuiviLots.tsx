// Qualité › Suivi Lots — quality-control lot tracking.
//
// Master-detail screen mirroring SousTraitantsCommandes / EtudesColoris:
//   - left list of lots (suivilot) with search + En cours / Terminé / Tous filter
//   - center: Récapitulatif de la commande (read-only) + spec banner + Pièces du
//     lot sub-table (read-only, per-roll Rdt = metrage/poids + Moyenne footer)
//   - right sidebar tabs: Contrôles (editable) / Documents / Défauts / Client
//   - status footer pill = the lot's computed STEP (LIVA #1304: attente contrôle
//     ennoblisseur / Malterre, à soumettre, soumis, refusé, rapport à envoyer, à
//     valider, en reprise, validé — components/qualite/LotCycle.tsx); its menu
//     holds the gestures: client accepts / refuses, Valider (refused by the API
//     while anything is left to do), Reprendre. The soumission and the rapport
//     de contrôle are sent from the header. The En cours / Terminé filters key
//     off the état (Validé = Terminé) — plus validated lots still owing an RC.
//   - LIVA #1313: a lot exists BEFORE its reception once its coloris is
//     submitted (« Soumettre un coloris » under the list: the lot the dyer
//     announces, typed). The client's yes on the coloris is the « coloris validé »,
//     mailed to the dyer from the footer / header; a refusal re-dyes the lot.
//
// Edit mode (Modifier → Enregistrer) only touches the Contrôles measurements +
// observations + emplacement + fin d'archivage (the sample-disposal date — when
// the physical swatch can be discarded; not a status). Plugged into the shared
// unsaved-changes guard.

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  ShieldCheck,
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  Save,
  Clock,
  RotateCcw,
  CheckCircle2,
  Truck,
  User,
  ChevronUp,
  Ruler,
  Package,
  FileText,
  AlertTriangle,
  Building2,
  ClipboardCheck,
  Factory,
  MessageSquare,
  LineChart,
  ClipboardList,
  MailCheck,
  Palette,
  Plus,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateLotQualityCaches, STOCK_QUERY_FRESHNESS } from '@/lib/cache-sync'
import { postEmail } from '@/lib/email'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import {
  SoumissionLotPicker,
  buildSoumissionLotQuery,
  type EligibleLot,
  type LotBloque,
} from '@/components/qualite/SoumissionLotPicker'
import {
  CycleCard,
  ETAPE_LOT_META,
  EtapeLotPill,
  LotCycleFooter,
  RcMenuButton,
  RefusClientDialog,
  natureEnAttente,
  SANS_SOUMISSIONS,
  type ClientRc,
  type EtapeLot,
  type GesteLot,
  type NatureSoumission,
  type SoumissionsLot,
} from '@/components/qualite/LotCycle'
import { TableauMetrageLotDialog } from '@/components/etiquettes/TableauMetrageLotDialog'
import { SmartSearchInput, filterRowsByTags, type SearchTagDef } from '@/components/stock/SmartSearchInput'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────

type Etat = 1 | 2 | 3 | 4 | 5

interface ListRow {
  IDsuivilot: number
  lot: string
  sous_traitant_nom: string
  IDetatLot: number | null
  etat_libelle: string | null
  /** Computed step (LIVA #1304); null on a lot tied to no dye order. */
  etape?: EtapeLot | null
  /** A validated lot still owes a client its rapport de contrôle. */
  rc_a_envoyer?: boolean
  /** Red / amber card (§41): the lot's relance is due (API urgenceLot). */
  urgence?: { niveau: NiveauUrgence; raison: string } | null
  date: string | null
}

type NiveauUrgence = 'rouge' | 'ambre'

interface QualityEntry {
  source: string
  author: string
  text: string
}

interface PieceRow {
  IDstock_fini: number
  numero: string
  poids: number
  metrage: number
  magasin_nom: string
  rdt: number | null
  valid: boolean | null
  quality: QualityEntry[]
}

interface ClientInfo {
  IDcommande_client: number
  IDclient: number
  nom: string
  numero: string | null
  ref_client: string | null
}

interface RepriseLot {
  id: number
  rang: number
  statut: 'ouverte' | 'close'
  origine: 'geste' | 'historique'
  motif: string | null
  envoye_le: string | null
  envoye_par: string | null
  retour_le: string | null
  retour_par: string | null
  lot_saisi: string | null
  rouleaux: number
}

interface SuiviLotDetail {
  IDsuivilot: number
  lot: string
  /** Its coloris is ordered by a client with labels: the tableau de métrage
   *  of the whole lot is asked from here (LIVA #1303). */
  etiquettes_sp?: boolean
  DATE: string | null
  IDcommande_sous_traitant: number
  IDligne_commande_sous_traitant: number
  IDsous_traitant: number
  date_commande: string | null
  reference: string
  coloris: string
  commentaire: string
  laize_demandee: number
  poids_demande: number
  rendement_demande: number
  freinte_demandee: number
  stabH_demandee: number
  stabL_demandee: number
  laize_sst: number
  poids_sst: number
  rendement_sst: number
  freinte_sst: number
  stabH_sst: number
  stabL_sst: number
  laize_tirelle: number
  poids_tirelle: number
  rendement_tirelle: number
  stabH_tirelle: number
  stabL_tirelle: number
  observations: string
  emplacement_tirelle: string
  fin_archivage: string
  IDetatLot: number | null
  etat_libelle: string | null
  /** The lot's reprises at the dyer, oldest first (absent on an older API). */
  reprises?: RepriseLot[]
  pieces: PieceRow[]
  moyenne_rdt: number | null
  rendement_mini: number | null
  rendement_maxi: number | null
  ref_bounds: RefBounds
  /** Client orders served by the lot, read from its pieces (#1249) — several
   *  when one sst order feeds more than one client order. */
  clients: ClientInfo[]
  // The lot's cycle (LIVA #1304) — absent on an older API.
  etape?: EtapeLot | null
  /** What still blocks « Valider le lot », in order. */
  prealables?: string[]
  /** The lot came back from the dyer (false: it exists through its coloris soumission, LIVA #1313). */
  recu?: boolean
  /** Coloris (before the stenter) and stabilités soumissions (LIVA #1313). */
  soumissions?: SoumissionsLot
  /** 'YYYY-MM-DD': the « coloris validé » mailed to the dyer. */
  ok_ramer_le?: string | null
  /** The controls the lot's reference asks (Finis › Références, 2026-10-26). Absent = both. */
  controles?: { ennoblisseur: boolean; malterre: boolean }
  /** The clients its pieces are affected to: the rapport de contrôle's recipients. */
  clients_rc?: ClientRc[]
}

interface RefBounds {
  laize_min: number
  laize_max: number
  poids_min: number
  poids_max: number
  stab_hauteur: number
  stab_largeur: number
}

interface DefautRow {
  IDdefaut_qualite: number
  roll_numero: string
  description: string
  type_defaut: string
  taille_cm: number
  nombre: number
  date: string
}

interface DocRow {
  IDged: number
  nom: string | null
  commentaire: string | null
  IDtype_doc: number
  type_nom: string | null
}

type StatusFilter = 'en_cours' | 'termine' | 'tous'

// État metadata — shared by the list-card icon and the footer pill.
const ETAT_META: Record<Etat, {
  label: string
  icon: typeof Clock
  solidBg: string
  iconColor: string
}> = {
  1: { label: 'En contrôle', icon: Clock, solidBg: 'bg-amber-500 border-amber-500', iconColor: 'text-amber-600' },
  2: { label: 'En reprise', icon: RotateCcw, solidBg: 'bg-orange-500 border-orange-500', iconColor: 'text-orange-600' },
  3: { label: 'Validé', icon: CheckCircle2, solidBg: 'bg-success border-success', iconColor: 'text-green-600' },
  4: { label: 'Expédié', icon: Truck, solidBg: 'bg-blue-500 border-blue-500', iconColor: 'text-blue-600' },
  5: { label: 'Attente Client', icon: User, solidBg: 'bg-violet-500 border-violet-500', iconColor: 'text-violet-600' },
}
const ETAT_ORDER: Etat[] = [1, 2, 3, 4, 5]

// The responsable qualité's only two manual verdicts. Other états are
// system-driven (reception → 1, soumission → 5, rework re-reception → 1).
const ETAT_ACTIONS: Etat[] = [3, 2] // Valider, Reprendre

function etatOf(id: number | null | undefined): Etat | null {
  const v = Number(id)
  return ETAT_ORDER.includes(v as Etat) ? (v as Etat) : null
}

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'en_cours', label: 'En cours' },
  { key: 'termine', label: 'Terminé' },
  { key: 'tous', label: 'Tous' },
]

// Editable Contrôles draft — strings so inputs allow free typing / empty.
interface EditState {
  laize_sst: string
  poids_sst: string
  rendement_sst: string
  stabH_sst: string
  stabL_sst: string
  laize_tirelle: string
  poids_tirelle: string
  rendement_tirelle: string
  stabH_tirelle: string
  stabL_tirelle: string
  observations: string
  emplacement_tirelle: string
  fin_archivage: string // yyyy-mm-dd
}

function numStr(v: number): string {
  return v === 0 ? '' : String(v)
}

function snapshotEdit(d: SuiviLotDetail): EditState {
  return {
    laize_sst: numStr(d.laize_sst),
    poids_sst: numStr(d.poids_sst),
    rendement_sst: numStr(d.rendement_sst),
    stabH_sst: numStr(d.stabH_sst),
    stabL_sst: numStr(d.stabL_sst),
    laize_tirelle: numStr(d.laize_tirelle),
    poids_tirelle: numStr(d.poids_tirelle),
    rendement_tirelle: numStr(d.rendement_tirelle),
    stabH_tirelle: numStr(d.stabH_tirelle),
    stabL_tirelle: numStr(d.stabL_tirelle),
    observations: d.observations ?? '',
    emplacement_tirelle: d.emplacement_tirelle ?? '',
    fin_archivage: hfsqlDateToInput(d.fin_archivage),
  }
}

// ── Page ─────────────────────────────────────────────────

export function QualiteSuiviLots() {
  const queryClient = useQueryClient()
  // Only the responsable qualité (and admins) can interact — everyone else
  // sees the screen read-only (no Modifier, no status change).
  const canManage = useHasPermission('responsable_qualite')
  // Deep link ?lot=<IDsuivilot> (Qualité › Analyse opens a lot here): only
  // validated lots are analysed, so the link lands on the « Terminés » list.
  const [searchParams, setSearchParams] = useSearchParams()
  const linkedLotId = (() => {
    const raw = parseInt(searchParams.get('lot') ?? '', 10)
    return isNaN(raw) || raw <= 0 ? null : raw
  })()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(linkedLotId !== null ? 'termine' : 'en_cours')
  const [searchQuery, setSearchQuery] = useState('')
  // Counter-pill toggles (mps_designer §41) and the search-bar step tag (one at a time).
  const [urgenceOn, setUrgenceOn] = useState<Record<NiveauUrgence, boolean>>({ rouge: false, ambre: false })
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(linkedLotId)
  useEffect(() => {
    if (searchParams.has('lot')) {
      const next = new URLSearchParams(searchParams)
      next.delete('lot')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [isEditing, setIsEditing] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [tableauOpen, setTableauOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'controles' | 'documents' | 'defauts' | 'actions'>('controles')
  const [edit, setEdit] = useState<EditState | null>(null)
  const originalRef = useRef<EditState | null>(null)

  // ── Queries ─────────────────────────────────────────────
  const {
    data: lots,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['suivi-lots', statusFilter],
    queryFn: () => apiFetch<ListRow[]>(`/suivi-lots?status=${statusFilter}`),
  })

  const { data: detail, isLoading: detailLoading, isError: detailError } = useQuery({
    queryKey: ['suivi-lot', selectedId],
    queryFn: () => apiFetch<SuiviLotDetail>(`/suivi-lots/${selectedId}`),
    enabled: selectedId !== null,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['suivi-lots'] })
    queryClient.invalidateQueries({ queryKey: ['suivi-lot', selectedId] })
  }, [queryClient, selectedId])

  // ── Edit lifecycle ──────────────────────────────────────
  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = snapshotEdit(detail)
    setEdit(snap)
    originalRef.current = snap
    setActiveTab('controles')
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

  const setEditField = useCallback(<K extends keyof EditState>(key: K, value: string) => {
    setEdit((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  // ── Mutations ───────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => {
      if (!edit) throw new Error('no edit state')
      return apiFetch(`/suivi-lots/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          laize_sst: edit.laize_sst,
          poids_sst: edit.poids_sst,
          rendement_sst: edit.rendement_sst,
          stabH_sst: edit.stabH_sst,
          stabL_sst: edit.stabL_sst,
          laize_tirelle: edit.laize_tirelle,
          poids_tirelle: edit.poids_tirelle,
          rendement_tirelle: edit.rendement_tirelle,
          stabH_tirelle: edit.stabH_tirelle,
          stabL_tirelle: edit.stabL_tirelle,
          observations: edit.observations,
          emplacement_tirelle: edit.emplacement_tirelle,
          fin_archivage: inputDateToHfsql(edit.fin_archivage),
        }),
      })
    },
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      setEdit(null)
      originalRef.current = null
    },
  })

  // Reprendre asks its motif first (RepriseMotifDialog): a reprise is recorded.
  const [repriseOpen, setRepriseOpen] = useState(false)
  const etatMut = useMutation({
    mutationFn: ({ etat, motif, nature }: { etat: Etat; motif?: string; nature?: 'rame' | 'teinture' }) =>
      apiFetch(`/suivi-lots/${selectedId}/etat`, {
        method: 'POST',
        body: JSON.stringify({ etat, motif, nature }),
      }),
    // Valider/Reprendre changes lot état and (on Reprendre) flags the lot's
    // rolls — both surface on Sous-traitants › Commandes, so refresh both
    // screens, not just this one.
    onSuccess: () => { invalidateLotQualityCaches(queryClient); setRepriseOpen(false) },
  })

  // The client's answer to the soumission waiting for it (LIVA #1304; coloris or
  // stabilités since #1313): a refusal asks why.
  const [refusOpen, setRefusOpen] = useState(false)
  // The « coloris validé » mail to the dyer (LIVA #1313).
  const [okRamerOpen, setOkRamerOpen] = useState(false)
  const natureReponse: NatureSoumission = (detail?.etape && natureEnAttente(detail.etape)) ?? 'stabilites'
  const reponseMut = useMutation({
    mutationFn: (p: { accepte: boolean; commentaire?: string }) =>
      apiFetch(`/suivi-lots/${selectedId}/reponse-client`, { method: 'POST', body: JSON.stringify({ ...p, nature: natureReponse }) }),
    onSuccess: (_r, p) => {
      invalidateLotQualityCaches(queryClient)
      setRefusOpen(false)
      // A coloris accepted before the reception goes straight on to the dyer's
      // mail; cancelling it leaves the step « Coloris validé, à transmettre ».
      if (p.accepte && natureReponse === 'coloris' && !detail?.recu) setOkRamerOpen(true)
    },
  })
  const onGeste = useCallback((g: GesteLot) => {
    etatMut.reset()
    reponseMut.reset()
    if (g === 'valider') etatMut.mutate({ etat: 3 })
    else if (g === 'reprendre') setRepriseOpen(true)
    else if (g === 'accepte') reponseMut.mutate({ accepte: true })
    else if (g === 'ok_ramer') setOkRamerOpen(true)
    else setRefusOpen(true)
  }, [etatMut, reponseMut])
  // A refused lot is taken back for the client's reason — a refused coloris re-dyes it.
  const soumissions = detail?.soumissions ?? SANS_SOUMISSIONS
  const refusColoris = soumissions.coloris.reponse && !soumissions.coloris.reponse.accepte ? soumissions.coloris.reponse : null
  const refus = detail?.etape === 'refuse_client'
    ? (refusColoris ?? (soumissions.stabilites.reponse && !soumissions.stabilites.reponse.accepte ? soumissions.stabilites.reponse : null))
    : null
  const motifReprise = refus?.commentaire ? `Refus client : ${refus.commentaire}` : ''
  // « Reprendre » asks rame or teinture only where the coloris is a matter (the client checks it).
  const repriseAvecNature = !!(soumissions.coloris.requise || soumissions.coloris.envoyee_le)
  const repriseNatureInitiale: 'rame' | 'teinture' = detail?.etape === 'refuse_client' && refusColoris ? 'teinture' : 'rame'

  // Soumission — the dye order's endpoints, narrowed to this lot (the picker
  // still names the client order and why a lot cannot go, LIVA #1302).
  const cmdId = detail?.IDcommande_sous_traitant ?? 0
  const { data: soumissionData } = useQuery<{ lots: EligibleLot[]; bloques?: LotBloque[] }>({
    queryKey: ['commande-sst-lots-eligibles', cmdId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${cmdId}/soumission/lots-eligibles`),
    enabled: canManage && cmdId > 0 && !isEditing,
    ...STOCK_QUERY_FRESHNESS,
  })
  const lotCourant = (detail?.lot ?? '').trim()
  const recu = detail?.recu ?? true
  // Which soumission the header button sends (LIVA #1313): the coloris while it
  // is the matter (asked and never sent, or re-dyed), else the stabilités.
  const natureSoumission: NatureSoumission =
    !recu || detail?.etape === 'coloris_a_soumettre' || detail?.etape === 'coloris_soumis' ? 'coloris' : 'stabilites'
  const soumissionLots = (soumissionData?.lots ?? [])
    .filter((l) => l.natures.includes(natureSoumission))
    .flatMap((l): EligibleLot[] => {
      if (recu) return l.kind === 'received' && l.lot.trim() === lotCourant ? [l] : []
      // Not received: the dyer line's coloris candidate, under this lot's number.
      return l.kind === 'manual' && l.ligneId === detail?.IDligne_commande_sous_traitant
        ? [{ ...l, kind: 'received', lot: lotCourant, key: `${l.key}|${lotCourant}` }]
        : []
    })
  const soumissionBloques = recu ? (soumissionData?.bloques ?? []).filter((b) => b.lot.trim() === lotCourant) : []
  const [soumissionPickerOpen, setSoumissionPickerOpen] = useState(false)
  // The lot being submitted, its dye order and which soumission.
  const [soumissionLot, setSoumissionLot] = useState<{ lot: EligibleLot; cmd: number; nature: NatureSoumission } | null>(null)
  // « Soumettre un coloris »: a lot the dyer announces, not received yet (LIVA #1313).
  const [colorisPickerOpen, setColorisPickerOpen] = useState(false)
  const { data: colorisCandidats } = useQuery<EligibleLot[]>({
    queryKey: ['suivi-lots-soumission-coloris'],
    queryFn: () => apiFetch('/suivi-lots/soumission-coloris/candidats'),
    enabled: canManage && colorisPickerOpen,
    ...STOCK_QUERY_FRESHNESS,
  })
  // Rapport de contrôle: the client it goes to.
  const [rcClient, setRcClient] = useState<ClientRc | null>(null)

  // ── Guard ───────────────────────────────────────────────
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
        setIsEditing(false)
        setEdit(null)
        originalRef.current = null
        setSelectedId(id)
      })
    },
    [guard],
  )

  const handleBack = useCallback(() => {
    guard.guardAction(() => {
      setIsEditing(false)
      setEdit(null)
      originalRef.current = null
      setSelectedId(null)
    })
  }, [guard])

  const handleStatusFilter = useCallback(
    (f: StatusFilter) => {
      guard.guardAction(() => {
        setIsEditing(false)
        setEdit(null)
        originalRef.current = null
        setStatusFilter(f)
        setSelectedId(null)
      })
    },
    [guard],
  )

  // ── Filtering + auto-select ─────────────────────────────
  // Counter pills (§41) count the status filter's list; a toggle disarms when its bucket empties
  // (the pill is hidden at 0, an armed empty filter would strand the user).
  const urgenceCounts = useMemo(() => {
    const c: Record<NiveauUrgence, number> = { rouge: 0, ambre: 0 }
    for (const l of lots ?? []) if (l.urgence) c[l.urgence.niveau] += 1
    return c
  }, [lots])
  const urgenceActive: Record<NiveauUrgence, boolean> = {
    rouge: urgenceOn.rouge && urgenceCounts.rouge > 0,
    ambre: urgenceOn.ambre && urgenceCounts.ambre > 0,
  }
  // Step tags, counted over the status filter's list without the free text (the text typed to
  // find a tag would otherwise narrow the list it is counted on).
  const tags = useMemo(() => lotTags(lots ?? []), [lots])

  const filtered = useMemo(() => {
    if (!lots) return []
    const q = searchQuery.trim().toLowerCase()
    let out = !q ? lots : lots.filter((l) => {
      const e = etatOf(l.IDetatLot)
      const uiLabel = l.etape ? ETAPE_LOT_META[l.etape].label : e ? ETAT_META[e].label : ''
      return [l.lot, l.sous_traitant_nom, l.etat_libelle ?? '', uiLabel, l.rc_a_envoyer ? 'rapport à envoyer' : '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
    if (urgenceActive.rouge || urgenceActive.ambre) out = out.filter((l) => l.urgence && urgenceActive[l.urgence.niveau])
    return filterRowsByTags(out, activeTags, tags)
  }, [lots, searchQuery, urgenceActive.rouge, urgenceActive.ambre, activeTags, tags])

  // Keep the selection valid against the (search-filtered) list. Skip while
  // editing so we never discard unsaved changes.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (l) => l.IDsuivilot,
    select: setSelectedId,
    // isLoading: the list is [] until it arrives — a linked lot must survive it.
    suspended: isEditing || isLoading,
  })

  // ── Render ──────────────────────────────────────────────
  return (
    <>
      <MasterDetailLayout
        hasSelection={selectedId !== null}
        onBack={handleBack}
        sidebarTitle="Contrôles"
        list={
          <LotList
            rows={filtered}
            totalCount={lots?.length ?? 0}
            isLoading={isLoading}
            isError={isError}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            tags={tags}
            activeTags={activeTags}
            onActiveTagsChange={(keys) => setActiveTags(keys.slice(-1))}
            urgenceCounts={urgenceCounts}
            urgenceOn={urgenceActive}
            onToggleUrgence={(n) => setUrgenceOn((v) => ({ ...v, [n]: !v[n] }))}
            statusFilter={statusFilter}
            onStatusFilterChange={handleStatusFilter}
            onSoumettreColoris={canManage && !isEditing ? () => setColorisPickerOpen(true) : undefined}
          />
        }
        detailHeader={
          detail ? (
            <LotDetailHeader
              detail={detail}
              isEditing={isEditing}
              saving={saveMut.isPending}
              canManage={canManage}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSave={() => saveMut.mutate()}
              onOpenGraph={() => setGraphOpen(true)}
              onOpenTableau={() => setTableauOpen(true)}
              soumissionCount={soumissionLots.length + soumissionBloques.length}
              natureSoumission={natureSoumission}
              onSoumettre={() => setSoumissionPickerOpen(true)}
              onOkRamer={() => setOkRamerOpen(true)}
              clientsRc={detail.clients_rc ?? []}
              onRapportControle={setRcClient}
            />
          ) : detailLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : null
        }
        detail={
          detail ? (
            <RecapSection detail={detail} />
          ) : detailError && selectedId !== null ? (
            // A failed detail load used to leave the panel blank (#1264).
            <div className="flex flex-col items-center justify-center py-10 text-destructive">
              <AlertCircle className="h-6 w-6 mb-2" />
              <span className="text-sm">Erreur de chargement du lot</span>
            </div>
          ) : selectedId === null && !isLoading ? (
            <EmptyDetailState />
          ) : null
        }
        sidebar={
          detail ? (
            <LotSidebar
              detail={detail}
              isEditing={isEditing}
              edit={edit}
              canManage={canManage}
              onEditField={setEditField}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onEtatChange={(e) => (e === 2 ? (etatMut.reset(), setRepriseOpen(true)) : etatMut.mutate({ etat: e }))}
              etatChanging={etatMut.isPending || reponseMut.isPending}
              onGeste={onGeste}
              cycleError={
                (etatMut.isError && !repriseOpen && etatMut.error instanceof Error ? etatMut.error.message : null)
                ?? (reponseMut.isError && !refusOpen && reponseMut.error instanceof Error ? reponseMut.error.message : null)
              }
            />
          ) : null
        }
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <LotTrendDialog open={graphOpen} onClose={() => setGraphOpen(false)} lotId={selectedId} />

      {detail?.etiquettes_sp && (
        <TableauMetrageLotDialog
          suivilotId={detail.IDsuivilot}
          lot={detail.lot}
          open={tableauOpen}
          onClose={() => setTableauOpen(false)}
        />
      )}

      <RepriseMotifDialog
        open={repriseOpen}
        lot={detail?.lot ?? ''}
        isPending={etatMut.isPending}
        error={etatMut.error instanceof Error ? etatMut.error.message : null}
        initialMotif={motifReprise}
        avecNature={repriseAvecNature}
        initialNature={repriseNatureInitiale}
        onCancel={() => setRepriseOpen(false)}
        onConfirm={(motif, nature) => etatMut.mutate({ etat: 2, motif, nature })}
      />

      <RefusClientDialog
        open={refusOpen}
        lot={detail?.lot ?? ''}
        nature={natureReponse}
        recu={recu}
        isPending={reponseMut.isPending}
        error={reponseMut.error instanceof Error ? reponseMut.error.message : null}
        onCancel={() => setRefusOpen(false)}
        onConfirm={(commentaire) => reponseMut.mutate({ accepte: false, commentaire })}
      />

      <SoumissionLotPicker
        open={soumissionPickerOpen}
        lots={soumissionLots}
        bloques={soumissionBloques}
        title={natureSoumission === 'coloris' ? 'Soumettre le coloris au client' : 'Soumettre les stabilités au client'}
        onClose={() => setSoumissionPickerOpen(false)}
        onSelect={(l) => { setSoumissionLot({ lot: l, cmd: cmdId, nature: natureSoumission }); setSoumissionPickerOpen(false) }}
      />
      <SoumissionLotPicker
        open={colorisPickerOpen}
        lots={colorisCandidats ?? []}
        bloques={[]}
        title="Soumettre un coloris (avant rame)"
        intro="Le lot que l’ennoblisseur annonce (« on peut soumettre le lot MA… cde N ») : la fiche part à l’ennoblisseur, qui y joint l’échantillon et l’envoie au client. Le lot apparaît ici dès l’envoi."
        onClose={() => setColorisPickerOpen(false)}
        onSelect={(l) => {
          setSoumissionLot({ lot: l, cmd: l.idcommande_sous_traitant ?? 0, nature: 'coloris' })
          setColorisPickerOpen(false)
        }}
      />
      {soumissionLot && soumissionLot.cmd > 0 && (
        <SendEmailDialog
          open
          onClose={() => setSoumissionLot(null)}
          title={soumissionLot.nature === 'coloris' ? 'Envoyer la soumission coloris' : undefined}
          contextLabel={`Lot ${soumissionLot.lot.lot} · ${soumissionLot.lot.client_nom}`}
          queryKey={['commande-sst-soumission-email-defaults', soumissionLot.cmd, soumissionLot.lot.key, soumissionLot.lot.lot, soumissionLot.nature]}
          loadDefaults={() => apiFetch(`/commandes-sous-traitant/${soumissionLot.cmd}/soumission/email-defaults?${buildSoumissionLotQuery(soumissionLot.lot, soumissionLot.nature)}`)}
          pdfUrl={`${API_URL}/commandes-sous-traitant/${soumissionLot.cmd}/soumission/pdf?${buildSoumissionLotQuery(soumissionLot.lot, soumissionLot.nature)}`}
          pdfAttachmentLabel={`soumission-${soumissionLot.nature === 'coloris' ? 'coloris' : 'lot'}-${soumissionLot.lot.lot}.pdf`}
          onSend={async (p) => {
            await postEmail(`${API_URL}/commandes-sous-traitant/${soumissionLot.cmd}/soumission/email`, p, {
              includeAttachPdf: true,
              extraBody: {
                ref_fini: soumissionLot.lot.IDref_fini,
                coloris: soumissionLot.lot.IDColoris,
                lot: soumissionLot.lot.lot,
                commande_client: soumissionLot.lot.IDcommande_client,
                nature: soumissionLot.nature,
              },
            })
            // The lot moves to « soumis » here and on the dye order (a coloris one is created).
            invalidateLotQualityCaches(queryClient)
            queryClient.invalidateQueries({ queryKey: ['suivi-lots-soumission-coloris'] })
            queryClient.invalidateQueries({ queryKey: ['commande-sst-historique', soumissionLot.cmd] })
          }}
        />
      )}
      {selectedId !== null && okRamerOpen && (
        <SendEmailDialog
          open
          onClose={() => setOkRamerOpen(false)}
          title="Transmettre la validation du coloris"
          contextLabel={`Lot ${detail?.lot ?? ''}`}
          queryKey={['suivi-lot-ok-ramer-email-defaults', selectedId]}
          loadDefaults={() => apiFetch(`/suivi-lots/${selectedId}/ok-ramer/email-defaults`)}
          onSend={async (p) => {
            await postEmail(`${API_URL}/suivi-lots/${selectedId}/ok-ramer/email`, p)
            invalidateLotQualityCaches(queryClient)
          }}
        />
      )}
      {selectedId !== null && rcClient && (
        <SendEmailDialog
          open
          onClose={() => setRcClient(null)}
          title="Envoyer le rapport de contrôle"
          contextLabel={`Lot ${detail?.lot ?? ''} · ${rcClient.nom}`}
          queryKey={['suivi-lot-rc-email-defaults', selectedId, rcClient.idclient]}
          loadDefaults={() => apiFetch(`/suivi-lots/${selectedId}/rapport-controle/email-defaults?client=${rcClient.idclient}`)}
          pdfUrl={`${API_URL}/suivi-lots/${selectedId}/rapport-controle/pdf?client=${rcClient.idclient}`}
          pdfAttachmentLabel={`rapport-controle-${detail?.lot ?? ''}.pdf`}
          onSend={async (p) => {
            await postEmail(`${API_URL}/suivi-lots/${selectedId}/rapport-controle/email`, p, {
              includeAttachPdf: true,
              extraBody: { client: rcClient.idclient },
            })
            invalidateLotQualityCaches(queryClient)
          }}
        />
      )}
    </>
  )
}

// ── Left list ────────────────────────────────────────────

// Urgence colours (mps_designer §41, raw palette): rouge = the lot's relance is due, ambre = next working day.
const URGENCE_CARD: Record<NiveauUrgence, { lisere: string; selected: string; hover: string; text: string }> = {
  rouge: {
    lisere: 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
    selected: 'border-red-500 ring-1 ring-red-500',
    hover: 'border-border hover:border-red-500/50',
    text: 'text-red-600',
  },
  ambre: {
    lisere: 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
    selected: 'border-amber-500 ring-1 ring-amber-500',
    hover: 'border-border hover:border-amber-500/50',
    text: 'text-amber-700',
  },
}

const URGENCE_PILLS: Array<{ niveau: NiveauUrgence; title: string; on: string; off: string }> = [
  {
    niveau: 'rouge',
    title: 'Lots à relancer ou à traiter maintenant',
    on: 'bg-red-500 text-white border-red-500 shadow-sm',
    off: 'bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20',
  },
  {
    niveau: 'ambre',
    title: 'Lots à relancer ou à traiter le prochain jour ouvré',
    on: 'bg-amber-500 text-white border-amber-500 shadow-sm',
    off: 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
  },
]

// Search-bar tags: one per step, in the cycle's order. « Rapport à envoyer » also holds the
// validated lots still owing a rapport de contrôle (their step reads « Validé »).
const ETAPE_TAG_ORDER: EtapeLot[] = [
  'coloris_soumis', 'reteinture', 'ok_ramer_a_envoyer', 'en_rame', 'coloris_a_soumettre',
  'attente_mesures', 'attente_tirelle', 'a_soumettre', 'soumis', 'refuse_client',
  'rc_a_envoyer', 'a_valider', 'en_reprise', 'valide',
]

function lotTags(rows: ListRow[]): SearchTagDef<ListRow>[] {
  return ETAPE_TAG_ORDER.map((etape): SearchTagDef<ListRow> => {
    const predicate = etape === 'rc_a_envoyer'
      ? (r: ListRow) => r.etape === 'rc_a_envoyer' || !!r.rc_a_envoyer
      : (r: ListRow) => r.etape === etape
    return {
      key: `etape:${etape}`,
      label: ETAPE_LOT_META[etape].label,
      renderPill: (trailing) => <EtapeLotPill etape={etape}>{trailing}</EtapeLotPill>,
      count: rows.filter(predicate).length,
      predicate,
    }
  })
}

/** The card's status pill: the computed step, else (a lot tied to no dye order) the état. */
function LotStatutPill({ row, className }: { row: ListRow; className?: string }) {
  if (row.etape) return <EtapeLotPill etape={row.etape} className={className} />
  const e = etatOf(row.IDetatLot)
  if (!e) return null
  const meta = ETAT_META[e]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solidBg, className)}>
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </Badge>
  )
}

function LotList({
  rows,
  totalCount,
  isLoading,
  isError,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  tags,
  activeTags,
  onActiveTagsChange,
  urgenceCounts,
  urgenceOn,
  onToggleUrgence,
  statusFilter,
  onStatusFilterChange,
  onSoumettreColoris,
}: {
  rows: ListRow[]
  totalCount: number
  isLoading: boolean
  isError: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (v: string) => void
  tags: SearchTagDef<ListRow>[]
  activeTags: string[]
  onActiveTagsChange: (keys: string[]) => void
  /** Lots per urgence level: the red and amber counter pills (§41). 0 hides a pill. */
  urgenceCounts: Record<NiveauUrgence, number>
  urgenceOn: Record<NiveauUrgence, boolean>
  onToggleUrgence: (n: NiveauUrgence) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (f: StatusFilter) => void
  /** « Soumettre un coloris » (LIVA #1313); absent = not allowed / edit mode. */
  onSoumettreColoris?: () => void
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      {/* Search + filter */}
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <SmartSearchInput<never, ListRow>
            className="flex-1 min-w-0"
            value={searchQuery}
            onValueChange={onSearchChange}
            tags={tags}
            activeTags={activeTags}
            onActiveTagsChange={onActiveTagsChange}
            placeholder="Rechercher un lot…"
            chipPlaceholder="Rechercher…"
          />
          {/* Counter pills: rouge (relance due), ambre (next working day). Number-only
              toggles, hidden when the bucket is empty (mps_designer §41). */}
          {URGENCE_PILLS.map((p) => urgenceCounts[p.niveau] > 0 && (
            <button
              key={p.niveau}
              type="button"
              onClick={() => onToggleUrgence(p.niveau)}
              aria-pressed={urgenceOn[p.niveau]}
              title={p.title}
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                urgenceOn[p.niveau] ? p.on : p.off,
              )}
            >
              {urgenceCounts[p.niveau]}
            </button>
          ))}
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

      {/* Rows */}
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-10 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <span className="text-sm">Erreur de chargement</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <ShieldCheck className="h-12 w-12 opacity-40 mb-2" />
            <span className="text-sm">Aucun lot</span>
          </div>
        ) : (
          rows.map((row) => {
            const isSelected = selectedId === row.IDsuivilot
            // Neutral by default (§41): the liseré says the lot's relance is due.
            const u = row.urgence ? URGENCE_CARD[row.urgence.niveau] : null
            const rcDu = !!row.rc_a_envoyer && row.etape === 'valide'
            return (
              <div
                key={row.IDsuivilot}
                onClick={() => onSelect(row.IDsuivilot)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  isSelected
                    ? (u?.selected ?? 'border-zinc-400 ring-1 ring-zinc-400')
                    : (u?.hover ?? 'border-border hover:border-zinc-400/60'),
                  u?.lisere,
                )}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium text-sm tabular-nums flex-shrink-0">{row.lot || '—'}</span>
                  <LotStatutPill row={row} className="ml-auto min-w-0" />
                </div>
                <p className="text-xs text-muted-foreground mt-1 truncate">{row.sous_traitant_nom || '—'}</p>
                {row.urgence && u && (
                  <p className={cn('text-[11px] font-medium mt-1 truncate', u.text)} title={row.urgence.raison}>
                    {row.urgence.raison}
                  </p>
                )}
                {(row.date || rcDu || row.etape) && (
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                    {row.date ? <span>Reçu le {formatHfsqlDate(row.date)}</span> : row.etape && <span className="italic">Pas encore réceptionné</span>}
                    {rcDu && (
                      <span className="ml-auto flex-shrink-0 rounded-full border border-amber-200 bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800" title="Rapport de contrôle à envoyer">
                        RC à envoyer
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer count + « Soumettre un coloris »: the way a lot enters before its
          reception (§5 « + Nouveau » slot, LIVA #1313). */}
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {rows.length} lot{rows.length !== 1 ? 's' : ''}
          {totalCount !== rows.length ? ` / ${totalCount}` : ''}
        </span>
        {onSoumettreColoris && (
          <Button
            size="sm"
            variant="ghost"
            className="text-accent hover:text-accent hover:bg-accent/10"
            title="Soumettre au client le coloris d’un lot que l’ennoblisseur annonce, avant rame"
            onClick={onSoumettreColoris}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />Soumettre un coloris
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Detail header ────────────────────────────────────────

function LotDetailHeader({
  detail,
  isEditing,
  saving,
  canManage,
  onStartEdit,
  onCancelEdit,
  onSave,
  onOpenGraph,
  onOpenTableau,
  soumissionCount,
  natureSoumission,
  onSoumettre,
  onOkRamer,
  clientsRc,
  onRapportControle,
}: {
  detail: SuiviLotDetail
  isEditing: boolean
  saving: boolean
  canManage: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onOpenGraph: () => void
  onOpenTableau: () => void
  /** Eligible + blocked soumission candidates for this lot (0 = no button). */
  soumissionCount: number
  /** What the soumission button sends: the coloris or the stabilités (LIVA #1313). */
  natureSoumission: NatureSoumission
  onSoumettre: () => void
  onOkRamer: () => void
  /** The lot's clients — the rapport de contrôle's possible recipients. */
  clientsRc: ClientRc[]
  onRapportControle: (c: ClientRc) => void
}) {
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{detail.lot || `Lot #${detail.IDsuivilot}`}</h1>
            {isEditing && (
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />
                Mode édition
              </Badge>
            )}
          </div>
          {!isEditing && (
            <div className="flex gap-1.5 mt-1 flex-wrap items-center text-sm text-muted-foreground">
              <span className="truncate">{detail.reference || '—'}</span>
              {(detail.reprises?.length ?? 0) > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full border border-orange-200 bg-orange-100 px-1.5 py-0 text-[10px] font-medium text-orange-800 flex-shrink-0"
                  title="Lot repris chez l’ennoblisseur (détail sous le récapitulatif)"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  {detail.reprises!.length > 1 ? `Repris ×${detail.reprises!.length}` : 'Repris'}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={onCancelEdit}>
                <X className="h-3.5 w-3.5 mr-1.5" />
                Annuler
              </Button>
              <Button size="sm" onClick={onSave} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Enregistrer
              </Button>
            </>
          ) : (
            <>
              {detail.etiquettes_sp && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title="Tableau de métrage Simone Pérèle — à envoyer à l'ennoblisseur, mesures à saisir"
                  onClick={onOpenTableau}
                >
                  <ClipboardList className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                title="Graphique d'évolution"
                onClick={onOpenGraph}
              >
                <LineChart className="h-4 w-4" />
              </Button>
              {canManage && soumissionCount > 0 && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 relative"
                  title={natureSoumission === 'coloris' ? 'Soumettre le coloris au client' : 'Soumettre les stabilités au client'}
                  onClick={onSoumettre}
                >
                  {natureSoumission === 'coloris' ? <Palette className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                  {(detail.etape === 'a_soumettre' || detail.etape === 'coloris_a_soumettre') && (
                    <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white" />
                  )}
                </Button>
              )}
              {canManage && (detail.etape === 'ok_ramer_a_envoyer' || detail.etape === 'en_rame') && (
                <Button variant="outline" size="icon" className="h-9 w-9 relative" title="Transmettre la validation du coloris à l’ennoblisseur" onClick={onOkRamer}>
                  <MailCheck className="h-4 w-4" />
                  {detail.etape === 'ok_ramer_a_envoyer' && (
                    <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white" />
                  )}
                </Button>
              )}
              {canManage && clientsRc.length > 0 && (
                <RcMenuButton clients={clientsRc} onSelect={onRapportControle} />
              )}
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
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Évolution (graphique) ────────────────────────────────
//
// "Graphique" modal: trend of the control measurements across every lot that
// shares this lot's référence AND sous-traitant (so values stay comparable).
// One point per lot, newest 200 (UI windows to 50/100/200). Self-contained SVG
// line chart — no charting dependency.

// Per-lot point (laize / poids / stab — measured once per lot).
interface TrendPoint {
  IDsuivilot: number
  lot: string
  date: string | null
  laize_sst: number; poids_sst: number; stabH_sst: number; stabL_sst: number
  laize_tirelle: number; poids_tirelle: number; stabH_tirelle: number; stabL_tirelle: number
  laize_demandee: number; poids_demande: number; stabH_demandee: number; stabL_demandee: number
}
// Per-roll point (rendement = the roll's actual rdt = metrage/poids).
interface TrendRoll {
  IDstock_fini: number
  IDsuivilot: number
  numero: string
  lot: string
  date: string | null
  rdt: number
  rendement_demande: number
}
interface TrendSerie {
  current_id: number
  reference: string
  sous_traitant_id: number
  sous_traitant_nom: string
  sous_traitants: { id: number; nom: string }[]
  points: TrendPoint[]
  rolls: TrendRoll[]
}

// Rendement is plotted per roll; laize / poids / stab per lot.
type ParamKey = 'rendement' | 'laize' | 'poids' | 'stabH' | 'stabL'
type SerieKey = 'roll' | 'sst' | 'tirelle' | 'cible'

const LOT_PARAMS: {
  key: Exclude<ParamKey, 'rendement'>; label: string; decimals: number
  fields: { sst: keyof TrendPoint; tirelle: keyof TrendPoint; cible: keyof TrendPoint }
}[] = [
  { key: 'laize', label: 'Laize', decimals: 1, fields: { sst: 'laize_sst', tirelle: 'laize_tirelle', cible: 'laize_demandee' } },
  { key: 'poids', label: 'Poids', decimals: 1, fields: { sst: 'poids_sst', tirelle: 'poids_tirelle', cible: 'poids_demande' } },
  { key: 'stabH', label: 'Stab H', decimals: 1, fields: { sst: 'stabH_sst', tirelle: 'stabH_tirelle', cible: 'stabH_demandee' } },
  { key: 'stabL', label: 'Stab L', decimals: 1, fields: { sst: 'stabL_sst', tirelle: 'stabL_tirelle', cible: 'stabL_demandee' } },
]
const PARAM_TABS: { key: ParamKey; label: string }[] = [
  { key: 'rendement', label: 'Rendement' },
  ...LOT_PARAMS.map((p) => ({ key: p.key as ParamKey, label: p.label })),
]

const SERIE_META: Record<SerieKey, { label: string; color: string; dashed?: boolean }> = {
  roll: { label: 'Rendement (rouleau)', color: 'hsl(var(--accent))' },
  sst: { label: 'Sous-traitant', color: 'hsl(var(--accent))' },
  tirelle: { label: 'Tirelle', color: 'hsl(var(--accent-blue))' },
  cible: { label: 'Demandé', color: 'hsl(var(--muted-foreground))', dashed: true },
}
const TREND_WINDOWS = [50, 100, 200] as const

// One X-axis point — a roll (rendement) or a lot (the other params).
interface ChartPoint {
  id: number
  primary: string
  secondary?: string
  date: string | null
  isCurrent: boolean
  values: Partial<Record<SerieKey, number | null>>
}

function trendDateLabel(d: string | null): string {
  return d && /^\d{8}$/.test(d) ? formatHfsqlDate(d) : '—'
}

function LotTrendDialog({
  open,
  onClose,
  lotId,
}: {
  open: boolean
  onClose: () => void
  lotId: number | null
}) {
  const [param, setParam] = useState<ParamKey>('rendement')
  const [activeSeries, setActiveSeries] = useState<Record<SerieKey, boolean>>({ roll: true, sst: true, tirelle: true, cible: false })
  const [windowSize, setWindowSize] = useState<(typeof TREND_WINDOWS)[number]>(50)
  // null = plot the current lot's own sous-traitant (the API default).
  const [selectedSstId, setSelectedSstId] = useState<number | null>(null)

  // Reset the sous-traitant scope when switching lots — a sst valid for one
  // référence may not exist for another.
  useEffect(() => { setSelectedSstId(null) }, [lotId])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['suivi-lot-serie', lotId, selectedSstId],
    queryFn: () => apiFetch<TrendSerie>(`/suivi-lots/${lotId}/serie${selectedSstId != null ? `?sst=${selectedSstId}` : ''}`),
    enabled: open && lotId !== null,
    placeholderData: keepPreviousData,
  })

  const isRendement = param === 'rendement'
  const sstOptions = data?.sous_traitants ?? []
  const plottedSstId = selectedSstId ?? data?.sous_traitant_id ?? 0

  // Chart model for the selected param: rendement → one point per roll;
  // laize / poids / stab → one point per lot.
  const model = useMemo(() => {
    const curId = data?.current_id ?? -1
    if (isRendement) {
      const rolls = (data?.rolls ?? []).slice(-windowSize)
      const points: ChartPoint[] = rolls.map((r) => ({
        id: r.IDstock_fini,
        primary: r.numero || `#${r.IDstock_fini}`,
        secondary: r.lot || undefined,
        date: r.date,
        isCurrent: r.IDsuivilot === curId,
        values: {
          roll: r.rdt > 0 ? r.rdt : null,
          cible: r.rendement_demande > 0 ? r.rendement_demande : null,
        },
      }))
      return { unit: 'roll' as const, decimals: 2, seriesKeys: ['roll', 'cible'] as SerieKey[], points, total: data?.rolls.length ?? 0 }
    }
    const cfg = LOT_PARAMS.find((p) => p.key === param)!
    const lots = (data?.points ?? []).slice(-windowSize)
    const num = (l: TrendPoint, f: keyof TrendPoint) => {
      const v = l[f] as number
      return typeof v === 'number' && v > 0 ? v : null
    }
    const points: ChartPoint[] = lots.map((l) => ({
      id: l.IDsuivilot,
      primary: l.lot || `Lot #${l.IDsuivilot}`,
      date: l.date,
      isCurrent: l.IDsuivilot === curId,
      values: { sst: num(l, cfg.fields.sst), tirelle: num(l, cfg.fields.tirelle), cible: num(l, cfg.fields.cible) },
    }))
    return { unit: 'lot' as const, decimals: cfg.decimals, seriesKeys: ['sst', 'tirelle', 'cible'] as SerieKey[], points, total: data?.points.length ?? 0 }
  }, [data, param, windowSize, isRendement])

  const visibleSeries = model.seriesKeys.filter((s) => activeSeries[s])
  const hasAnyData = (data?.points.length ?? 0) > 0 || (data?.rolls.length ?? 0) > 0
  const hasCurrent = model.points.some((p) => p.isCurrent)
  const unitWord = (count: number) => (model.unit === 'roll' ? `rouleau${count > 1 ? 'x' : ''}` : `lot${count > 1 ? 's' : ''}`)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl w-[92vw] h-[82vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0">
            <LineChart className="h-5 w-5 text-accent flex-shrink-0" />
            <span>Évolution des contrôles</span>
            {!!data && !!data.reference && (
              <span className="text-sm font-normal text-muted-foreground truncate">— {data.reference}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 flex-1 min-h-0 flex flex-col gap-3">
          {/* Sous-traitant scope — selectable when several worked on the réf */}
          {sstOptions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Sous-traitant</span>
              {sstOptions.length > 1 ? (
                <PopoverSelect
                  size="sm"
                  hideEmpty
                  options={sstOptions.map((s) => ({ id: s.id, primary: s.nom }))}
                  value={plottedSstId}
                  onChange={(id) => setSelectedSstId(id)}
                />
              ) : (
                <span className="text-sm font-medium">{sstOptions[0].nom}</span>
              )}
            </div>
          )}

          {/* Parameter selector */}
          <div className="flex flex-wrap gap-1">
            {PARAM_TABS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setParam(p.key)}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-md transition-colors',
                  param === p.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Window + series toggles */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Fenêtre</span>
              <div className="flex gap-1">
                {TREND_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWindowSize(w)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md transition-colors tabular-nums',
                      windowSize === w ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                    )}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {model.seriesKeys.map((s) => {
                const meta = SERIE_META[s]
                const active = activeSeries[s]
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setActiveSeries((prev) => ({ ...prev, [s]: !prev[s] }))}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md border flex items-center gap-1.5 transition-colors',
                      active ? 'bg-white border-border shadow-sm' : 'border-transparent text-muted-foreground hover:bg-white/60',
                    )}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: meta.color, opacity: active ? 1 : 0.35 }} />
                    {meta.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Chart */}
          <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-white p-3 relative">
            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            ) : isError ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
                Erreur de chargement
              </div>
            ) : !hasAnyData ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground italic px-6 text-center">
                Aucun lot comparable (même référence et même sous-traitant).
              </div>
            ) : model.points.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground italic px-6 text-center">
                {isRendement ? 'Aucun rouleau reçu pour ce paramètre.' : 'Aucune donnée disponible pour ce paramètre.'}
              </div>
            ) : visibleSeries.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground italic">
                Sélectionnez au moins une série.
              </div>
            ) : (
              <TrendChart points={model.points} seriesKeys={visibleSeries} decimals={model.decimals} />
            )}
          </div>

          {hasAnyData && model.points.length > 0 && (
            <p className="text-[11px] text-muted-foreground flex-shrink-0">
              {model.points.length} {unitWord(model.points.length)} affiché{model.points.length > 1 ? 's' : ''}
              {model.total > model.points.length ? ` (sur ${model.total})` : ''}
              {hasCurrent ? ` · ${model.unit === 'roll' ? 'les rouleaux du lot courant sont cerclés' : 'le lot courant est cerclé'} en or` : ''} · 0 = non mesuré (omis)
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TrendChart({
  points,
  seriesKeys,
  decimals,
}: {
  points: ChartPoint[]
  seriesKeys: SerieKey[]
  decimals: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => { setWidth(el.clientWidth); setHeight(el.clientHeight) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const valOf = (pt: ChartPoint, s: SerieKey): number | null => {
    const v = pt.values[s]
    return v != null && v > 0 ? v : null
  }

  const M = { top: 16, right: 16, bottom: 30, left: 48 }
  const plotW = Math.max(0, width - M.left - M.right)
  const plotH = Math.max(0, height - M.top - M.bottom)
  const n = points.length

  // Y domain across active series (treat 0 / negative as not measured).
  const allVals: number[] = []
  for (const pt of points) for (const s of seriesKeys) { const v = valOf(pt, s); if (v != null) allVals.push(v) }
  const hasData = allVals.length > 0
  let yMin = hasData ? Math.min(...allVals) : 0
  let yMax = hasData ? Math.max(...allVals) : 1
  if (yMin === yMax) { yMin -= 1; yMax += 1 }
  const yPad = (yMax - yMin) * 0.1
  yMin -= yPad; yMax += yPad

  const xFor = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const yFor = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH

  const pathFor = (s: SerieKey): string => {
    let d = ''
    let pen = false
    points.forEach((pt, i) => {
      const v = valOf(pt, s)
      if (v == null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)} `
      pen = true
    })
    return d.trim()
  }

  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (i / 4) * (yMax - yMin))
  const xTickCount = Math.min(6, n)
  const xTickIdx = Array.from(
    new Set(
      n <= 1 ? [0] : Array.from({ length: xTickCount }, (_, i) => Math.round((i / (xTickCount - 1)) * (n - 1))),
    ),
  )
  // Indices belonging to the current lot (one in lot mode, several in roll mode).
  const currentIdx: number[] = []
  points.forEach((p, i) => { if (p.isCurrent) currentIdx.push(i) })

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!width || n === 0 || plotW <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const i = n <= 1 ? 0 : Math.round(((x - M.left) / plotW) * (n - 1))
    setHoverIdx(Math.max(0, Math.min(n - 1, i)))
  }

  const muted = 'hsl(var(--muted-foreground))'
  const border = 'hsl(var(--border))'
  const accent = 'hsl(var(--accent))'
  const ready = width > 0 && height > 0

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {ready && (
        <svg
          width={width}
          height={height}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Horizontal gridlines + Y labels */}
          {yTicks.map((t, i) => {
            const y = yFor(t)
            return (
              <g key={i}>
                <line x1={M.left} y1={y} x2={M.left + plotW} y2={y} style={{ stroke: border }} strokeWidth={1} strokeDasharray={i === 0 ? undefined : '3 3'} />
                <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize={10} style={{ fill: muted }}>
                  {fmtNum(t, decimals)}
                </text>
              </g>
            )
          })}

          {/* X labels (dates) */}
          {xTickIdx.map((idx, k) => {
            const x = xFor(idx)
            const anchor = k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'
            return (
              <text key={idx} x={x} y={M.top + plotH + 16} textAnchor={anchor} fontSize={10} style={{ fill: muted }}>
                {trendDateLabel(points[idx]?.date ?? null)}
              </text>
            )
          })}

          {/* Current-lot guide(s) */}
          {currentIdx.map((i) => (
            <line
              key={`cur-${i}`}
              x1={xFor(i)} y1={M.top} x2={xFor(i)} y2={M.top + plotH}
              style={{ stroke: accent }} strokeWidth={1} strokeDasharray="4 3" opacity={0.35}
            />
          ))}

          {/* Hover guide */}
          {hoverIdx != null && (
            <line x1={xFor(hoverIdx)} y1={M.top} x2={xFor(hoverIdx)} y2={M.top + plotH} style={{ stroke: muted }} strokeWidth={1} opacity={0.4} />
          )}

          {/* Series lines */}
          {seriesKeys.map((s) => (
            <path
              key={s}
              d={pathFor(s)}
              fill="none"
              style={{ stroke: SERIE_META[s].color }}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={SERIE_META[s].dashed ? '5 3' : undefined}
            />
          ))}

          {/* Series points */}
          {seriesKeys.map((s) =>
            points.map((pt, i) => {
              const v = valOf(pt, s)
              if (v == null) return null
              const isCur = pt.isCurrent
              const isHover = i === hoverIdx
              return (
                <circle
                  key={`${s}-${i}`}
                  cx={xFor(i)}
                  cy={yFor(v)}
                  r={isHover ? 4 : isCur ? 3.5 : 2.25}
                  style={{ fill: SERIE_META[s].color }}
                  stroke={isCur ? accent : 'white'}
                  strokeWidth={isCur ? 2 : isHover ? 1.5 : 0.75}
                />
              )
            }),
          )}
        </svg>
      )}

      {/* Empty-data overlay (axes drawn, but no measured values) */}
      {ready && !hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground italic px-6 text-center">
          Aucune mesure disponible pour ce paramètre.
        </div>
      )}

      {/* Tooltip */}
      {ready && hasData && hoverIdx != null && (() => {
        const pt = points[hoverIdx]
        const x = xFor(hoverIdx)
        const flip = x > width / 2
        return (
          <div
            className="absolute z-10 pointer-events-none rounded-md border bg-white shadow-md px-2.5 py-1.5 text-xs min-w-[150px]"
            style={{
              top: M.top,
              left: flip ? undefined : Math.min(x + 10, width - 8),
              right: flip ? Math.min(width - x + 10, width - 8) : undefined,
            }}
          >
            <div className="font-medium truncate">{pt.primary}</div>
            {!!pt.secondary && <div className="text-[10px] text-muted-foreground truncate">{pt.secondary}</div>}
            <div className="text-[10px] text-muted-foreground mb-1">{trendDateLabel(pt.date)}</div>
            {seriesKeys.map((s) => {
              const v = valOf(pt, s)
              return (
                <div key={s} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: SERIE_META[s].color }} />
                  <span className="text-muted-foreground">{SERIE_META[s].label}</span>
                  <span className="ml-auto tabular-nums font-medium">{v != null ? fmtNum(v, decimals) : '—'}</span>
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}

// ── Center: Récapitulatif + Pièces ───────────────────────

function RecapSection({ detail }: { detail: SuiviLotDetail }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 scrollbar-transparent pr-1">
      {detail.etape && (
        <CycleCard
          etape={detail.etape}
          prealables={detail.prealables ?? []}
          soumissions={detail.soumissions ?? SANS_SOUMISSIONS}
          okRamerLe={detail.ok_ramer_le ?? null}
          recu={detail.recu ?? true}
          clients={detail.clients_rc ?? []}
        />
      )}
      {/* Récapitulatif */}
      <div className="rounded-xl border bg-card shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <ClipboardCheck className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Récapitulatif de la commande</h2>
        </div>
        {/* Two orders meet on a lot: the sous-traitant order we placed, and the
            client order it serves. They carry same-named fields (both have a
            "Commande N°"), so each gets its own bounded panel rather than being
            interleaved in one flat list — the panel header disambiguates, which
            also lets every field keep its short, natural label.

            Deliberately NOT repeated here: `lot` and `reference`. They are the
            detail header's H1 and subtitle two lines above; listing them again
            was pure duplication and it left the client column short by two
            rows. Dropping them balances the panels at 3 rows each. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <RecapGroup icon={Factory} title="Commande sous-traitant">
            <RecapField label="Date commande" value={detail.date_commande ? formatHfsqlDate(detail.date_commande) : '—'} />
            <RecapField label="Commande N°" value={detail.IDcommande_sous_traitant ? String(detail.IDcommande_sous_traitant) : '—'} mono />
            <RecapField label="Coloris" value={detail.coloris || '—'} />
          </RecapGroup>

          {/* Absorbed from the former "Client" sidebar tab (removed — it only
              duplicated the client name already shown here). */}
          <RecapGroup icon={Building2} title={detail.clients.length > 1 ? 'Commandes client' : 'Commande client'}>
            {detail.clients.length > 0 ? (
              <div className="divide-y divide-border/40">
                {detail.clients.map((c) => (
                  <div key={c.IDcommande_client} className="py-1.5 first:pt-0 last:pb-0">
                    <RecapField label="Client final" value={c.nom || '—'} />
                    <RecapField label="Commande N°" value={c.numero || '—'} mono />
                    <RecapField label="Réf. client" value={c.ref_client || '—'} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">Aucune commande client rattachée</p>
            )}
          </RecapGroup>
        </div>
        {/* commande_sous_traitant.commentaire — the note on the order WE placed,
            nothing client-side. Full width because comments are multi-line and
            would be cramped inside a half-width panel, so the label has to name
            its owner itself (the panel grouping above can't). */}
        {!!detail.commentaire?.trim() && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-zinc-50/70 p-3">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground/60 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Commentaire · commande sous-traitant
              </p>
              <p className="text-sm whitespace-pre-line mt-0.5">{detail.commentaire}</p>
            </div>
          </div>
        )}
        {/* Spec banner — the lot's target values, so it keeps a divider above:
            it belongs to the lot, not to either order panel. */}
        <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 sm:grid-cols-6 gap-2">
          <SpecStat label="Laize" value={fmtNum(detail.laize_demandee)} />
          <SpecStat label="Poids" value={fmtNum(detail.poids_demande)} />
          <SpecStat label="Freinte" value={fmtNum(detail.freinte_demandee * 100, 0)} suffix="%" />
          <SpecStat label="Rendement" value={fmtNum(detail.rendement_demande, 2)} highlight />
          <SpecStat label="Stab H" value={fmtNum(detail.stabH_demandee)} />
          <SpecStat label="Stab L" value={fmtNum(detail.stabL_demandee)} />
        </div>
      </div>

      {/* Pièces du lot */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 p-4 pb-2">
          <Package className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Pièces du lot</h2>
          {detail.rendement_mini != null && detail.rendement_maxi != null && (
            <span className="text-[11px] text-muted-foreground">
              Rdt conforme : {fmtNum(detail.rendement_mini, 2)} – {fmtNum(detail.rendement_maxi, 2)}
            </span>
          )}
          <Badge variant="secondary" className="text-xs ml-auto">{detail.pieces.length}</Badge>
        </div>
        {detail.pieces.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground italic">Aucune pièce reçue</p>
        ) : (
          <div className="px-2 pb-2">
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
                  <th className="px-2 py-2 text-left font-semibold">Numéro</th>
                  <th className="px-2 py-2 text-right font-semibold">Poids</th>
                  <th className="px-2 py-2 text-right font-semibold">Métrage</th>
                  <th className="px-2 py-2 text-left font-semibold">Magasin</th>
                  <th className="px-2 py-2 text-right font-semibold">Rdt</th>
                  <th className="px-2 py-2 text-center font-semibold">Conforme</th>
                  <th className="px-2 py-2 text-center font-semibold">Qualité</th>
                </tr>
              </thead>
              <tbody>
                {detail.pieces.map((p) => (
                  <tr key={p.IDstock_fini} className="border-b border-border/40">
                    <td className="px-2 py-1.5 truncate" title={p.numero}>{p.numero}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(p.poids, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(p.metrage, 2)}</td>
                    <td className="px-2 py-1.5 truncate text-muted-foreground" title={p.magasin_nom}>{p.magasin_nom || '—'}</td>
                    <td className={cn(
                      'px-2 py-1.5 text-right tabular-nums',
                      p.valid === true && 'text-green-600 font-medium',
                      p.valid === false && 'text-destructive font-medium',
                    )}>
                      {p.rdt != null ? fmtNum(p.rdt, 2) : '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      {p.valid == null ? (
                        <span className="block text-center text-muted-foreground">—</span>
                      ) : p.valid ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600 mx-auto" aria-label="Conforme" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-destructive mx-auto" aria-label="Non conforme" />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex justify-center">
                        <QualityHistoryCell numero={p.numero} quality={p.quality} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs font-semibold border-t border-border/60">
                  <td className="px-2 py-2 text-muted-foreground">Total</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {fmtNum(detail.pieces.reduce((s, p) => s + (p.poids || 0), 0), 2)} Kg
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {fmtNum(detail.pieces.reduce((s, p) => s + (p.metrage || 0), 0), 2)} Ml
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">Moyenne</td>
                  <td className="px-2 py-2 text-right tabular-nums text-accent">
                    {detail.moyenne_rdt != null ? fmtNum(detail.moyenne_rdt, 2) : '—'}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <ReprisesCard reprises={detail.reprises ?? []} />
    </div>
  )
}

/** One of the récapitulatif's two order panels. Bounding each order in its own
 *  surface is what makes the two "Commande N°" rows unambiguous at a glance —
 *  a bare divider between columns wasn't enough. */
function RecapGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-zinc-50/70 p-3">
      <div className="flex items-center gap-1.5 pb-2 mb-2 border-b border-border/40">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" />
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
          {title}
        </p>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

/** Label left / value right. No per-row rule: inside a bounded panel the
 *  ledger lines just added noise, and the panel border already does the
 *  containing. `mono` gives ids tabular figures so they align. */
function RecapField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className={cn('text-sm text-right truncate font-medium', mono && 'tabular-nums')} title={value}>
        {value}
      </span>
    </div>
  )
}

function SpecStat({ label, value, suffix, highlight }: { label: string; value: string; suffix?: string; highlight?: boolean }) {
  return (
    <div className={cn('rounded-md border px-2 py-1.5 text-center', highlight ? 'border-accent/40 bg-accent/[0.05]' : 'border-border/60 bg-zinc-50')}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('text-sm font-semibold tabular-nums', highlight && 'text-accent')}>
        {value || '0'}{suffix ?? ''}
      </div>
    </div>
  )
}

function EmptyDetailState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center">
      <div className="icon-box-gold h-16 w-16 flex items-center justify-center rounded-xl mb-4">
        <ShieldCheck className="h-8 w-8" />
      </div>
      <p className="text-sm text-muted-foreground">Sélectionnez un lot pour afficher son suivi qualité.</p>
    </div>
  )
}

// ── Right sidebar (tabs + status footer) ─────────────────

function LotSidebar({
  detail,
  isEditing,
  edit,
  canManage,
  onEditField,
  activeTab,
  onTabChange,
  onEtatChange,
  etatChanging,
  onGeste,
  cycleError,
}: {
  detail: SuiviLotDetail
  isEditing: boolean
  edit: EditState | null
  canManage: boolean
  onEditField: <K extends keyof EditState>(key: K, value: string) => void
  activeTab: 'controles' | 'documents' | 'defauts' | 'actions'
  onTabChange: (t: 'controles' | 'documents' | 'defauts' | 'actions') => void
  onEtatChange: (e: Etat) => void
  etatChanging: boolean
  onGeste: (g: GesteLot) => void
  /** A refused gesture (e.g. « Valider » with something left to do). */
  cycleError: string | null
}) {
  const tabs = [
    { key: 'controles' as const, label: 'Contrôles', icon: Ruler },
    { key: 'documents' as const, label: 'Documents', icon: FileText },
    { key: 'defauts' as const, label: 'Défauts', icon: AlertTriangle },
    // Conformité vs the standing quality instructions attached to this lot's
    // sst line in Qualité › Actions.
    { key: 'actions' as const, label: 'Actions', icon: ClipboardCheck },
  ]
  // NB: there is deliberately no "Client" tab. It only ever held the client
  // name (already in the récapitulatif), the client order N° and the réf.
  // client — all three now live in the récapitulatif. Four tabs is also the
  // most that fits the w-96 sidebar; adding a fifth overflowed it.
  const currentEtat = etatOf(detail.IDetatLot)

  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTabChange(t.key)}
                title={t.label}
                className={cn(
                  // min-w-0 lets a tab shrink below its label width and the
                  // label truncate instead of pushing the row past the w-96
                  // panel (what happened when a 5th tab was added). The icon
                  // stays flex-shrink-0 so a squeezed tab is still identifiable.
                  'flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium rounded-md transition-colors',
                  active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{t.label}</span>
              </button>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
          {activeTab === 'controles' && <ControlesTab detail={detail} isEditing={isEditing} edit={edit} onEditField={onEditField} />}
          {activeTab === 'documents' && <DocumentsTab commandeId={detail.IDcommande_sous_traitant} />}
          {activeTab === 'defauts' && <DefautsTab lotId={detail.IDsuivilot} />}
          {activeTab === 'actions' && <ActionsQualiteTab lotId={detail.IDsuivilot} canManage={canManage} />}
        </div>
      </div>

      {detail.etape ? (
        <LotCycleFooter
          etape={detail.etape}
          prealables={detail.prealables ?? []}
          recu={detail.recu ?? true}
          canManage={canManage}
          isChanging={etatChanging}
          disabled={isEditing}
          onGeste={onGeste}
        />
      ) : currentEtat && (
        <EtatFooter
          current={currentEtat}
          canManage={canManage}
          onChange={onEtatChange}
          isChanging={etatChanging}
          disabled={isEditing}
        />
      )}
      {cycleError && (
        <div className="flex-shrink-0 flex items-start gap-2 text-xs text-destructive px-1">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{cycleError}</span>
        </div>
      )}
    </div>
  )
}

// ── Actions qualité tab ──────────────────────────────────
//
// The mentions (automatic sst-order comments) from Qualité › Actions that apply
// to this lot's ligne_commande_sous_traitant, each with its conformité verdict.
// Verdicts write immediately — they're standalone judgements, not part of the
// Contrôles form, so they follow the lot-état precedent rather than edit mode.

type LotConformite = 'non_controle' | 'conforme' | 'non_conforme' | 'aucun'

interface LotActionRow {
  IDmention_qualite: number
  IDaction_qualite: number
  action_titre: string
  action_description: string
  action_termine: 0 | 1
  mention: string
  conformite: LotConformite
  /** false ⇒ listed only because a verdict already exists (action closed since,
   *  or the line no longer matches). Read-only history, not a live instruction. */
  applicable: boolean
}

const LOT_CONFORMITE_CHOICES: { key: LotConformite; label: string; active: string }[] = [
  { key: 'conforme', label: 'Conforme', active: 'bg-emerald-600 text-white border-emerald-600' },
  { key: 'non_conforme', label: 'Non conforme', active: 'bg-red-600 text-white border-red-600' },
  { key: 'non_controle', label: 'Non contrôlé', active: 'bg-zinc-500 text-white border-zinc-500' },
]

function ActionsQualiteTab({ lotId, canManage }: { lotId: number; canManage: boolean }) {
  const queryClient = useQueryClient()
  const queryKey = ['suivi-lot-actions', lotId]

  const { data, isLoading, isError } = useQuery<LotActionRow[]>({
    queryKey,
    queryFn: () => apiFetch(`/suivi-lots/${lotId}/actions`),
  })

  const [pendingId, setPendingId] = useState<number | null>(null)

  const setMut = useMutation({
    mutationFn: ({ mentionId, conformite }: { mentionId: number; conformite: LotConformite }) =>
      apiFetch(`/suivi-lots/${lotId}/actions/${mentionId}`, {
        method: 'PUT',
        body: JSON.stringify({ conformite }),
      }),
    onMutate: ({ mentionId }) => setPendingId(mentionId),
    onSettled: () => setPendingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      // The Actions screen shows these verdicts aggregated — keep it honest.
      queryClient.invalidateQueries({ queryKey: ['actions-qualite'] })
      queryClient.invalidateQueries({ queryKey: ['action-qualite'] })
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-destructive">
        <AlertCircle className="h-8 w-8 mb-2" />
        <p className="text-sm">Erreur de chargement</p>
      </div>
    )
  }
  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
        <ClipboardCheck className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm">Aucune action qualité</p>
        <p className="text-xs mt-1 text-center px-4">
          Aucune mention de Qualité › Actions ne correspond à cette commande.
        </p>
      </div>
    )
  }

  return (
    <>
      {data.map((row) => {
        const busy = pendingId === row.IDmention_qualite && setMut.isPending
        return (
          <div
            key={row.IDmention_qualite}
            className={cn(
              'p-3 rounded-lg border bg-card shadow-sm',
              !row.applicable && 'opacity-70',
            )}
          >
            <div className="flex items-start gap-2">
              <ClipboardCheck className="h-3.5 w-3.5 text-accent flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">
                  {row.action_titre.trim() || `Action N° ${row.IDaction_qualite}`}
                </p>
                {!row.applicable && (
                  <p className="text-[10px] text-muted-foreground italic mt-0.5">
                    {row.action_termine === 1
                      ? 'Action terminée — contrôle conservé pour historique'
                      : 'Ne correspond plus à cette commande — historique'}
                  </p>
                )}
              </div>
            </div>

            {!!row.mention.trim() && (
              <div className="flex items-start gap-1.5 mt-2">
                <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-muted-foreground italic whitespace-pre-line">
                  {row.mention.trim()}
                </p>
              </div>
            )}

            <div className="flex gap-1 mt-2.5">
              {LOT_CONFORMITE_CHOICES.map((c) => {
                const active = row.conformite === c.key
                return (
                  <button
                    key={c.key}
                    type="button"
                    disabled={!canManage || busy}
                    onClick={() => {
                      if (active) return
                      setMut.mutate({ mentionId: row.IDmention_qualite, conformite: c.key })
                    }}
                    className={cn(
                      'flex-1 px-2 py-1 text-[11px] rounded-md border transition-colors',
                      active
                        ? `${c.active} font-medium shadow-sm`
                        : 'border-input text-muted-foreground hover:bg-accent/10',
                      (!canManage || busy) && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    {busy && active ? '…' : c.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

// ── Contrôles tab ────────────────────────────────────────

const editCardClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

type ConformKind = 'laize' | 'poids' | 'stabH' | 'stabL' | 'rendement'

// A measurement's tolerance: a min/max band. `null` on a bound means "not
// defined" (legacy stores 0 for undefined bounds — treat <=0 as absent). Stab
// measurements only carry a lower bound (≥ min), so `max` stays null.
interface Tolerance {
  min: number | null
  max: number | null
}

// Resolve the tolerance band for a measurement from the ref_fini bounds (laize/
// poids/stab) or the per-lot rendement bounds. <=0 bounds are dropped to null.
function resolveTolerance(kind: ConformKind, b: RefBounds | undefined, rdt: Tolerance | undefined): Tolerance {
  const pos = (n: number | null | undefined): number | null => (n != null && n > 0 ? n : null)
  // Symmetric band from a single ±figure: -5 → [-5, +5]. Returns the empty band
  // when undefined (0).
  const sym = (n: number | null | undefined): Tolerance => {
    const a = n != null ? Math.abs(n) : 0
    return a > 0 ? { min: -a, max: a } : { min: null, max: null }
  }
  switch (kind) {
    case 'laize': return { min: pos(b?.laize_min), max: pos(b?.laize_max) }
    case 'poids': return { min: pos(b?.poids_min), max: pos(b?.poids_max) }
    // Stab is a symmetric tolerance: the ref_fini stores a single figure (e.g.
    // -5) meaning the fabric may move ±5% — mostly shrink, occasionally stretch.
    // A measurement is conform when it lands in [-|x|, +|x|].
    case 'stabH': return sym(b?.stab_hauteur)
    case 'stabL': return sym(b?.stab_largeur)
    case 'rendement': return { min: pos(rdt?.min), max: pos(rdt?.max) }
  }
}

// Conformité d'une mesure vs sa tolérance. Returns null when there's nothing to
// flag: no bound defined, or value not entered (0).
function checkConform(val: number, t: Tolerance): boolean | null {
  if (t.min == null && t.max == null) return null
  // 0 = control not made yet (no marker). A real measurement is non-zero —
  // including negative stab readings (shrinkage).
  if (val === 0) return null
  if (t.min != null && val < t.min) return false
  if (t.max != null && val > t.max) return false
  return true
}

function ConformMarker({ conform }: { conform: boolean | null }) {
  if (conform == null) return null
  return conform ? (
    <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" aria-label="Conforme" />
  ) : (
    <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" aria-label="Non conforme" />
  )
}

// Tolerance gauge: a track showing the acceptable band. Two-bound measurements
// (laize, poids) show a min→max band; stab shows a 0-centered ±band. The
// measured value is a needle — green inside tolerance, red outside, grey when
// not yet measured. Bound labels sit under the band edges. Updates live as the
// value is typed in edit mode. Returns null when no bound is defined.
function ToleranceGauge({ value, tol, conform, dec }: { value: number; tol: Tolerance; conform: boolean | null; dec: number }) {
  if (tol.min == null && tol.max == null) return null
  const hasMax = tol.max != null
  const lo = tol.min ?? 0
  const hi = tol.max ?? lo

  // Display domain pads the band so the needle stays visible on/just past an edge.
  let domainLo: number
  let domainHi: number
  if (hasMax) {
    const pad = Math.max((hi - lo) * 0.3, lo * 0.05, 1)
    domainLo = lo - pad
    domainHi = hi + pad
  } else {
    // ≥min threshold: keep the threshold around the lower third of the track.
    const span = Math.max(Math.abs(value - lo), lo * 0.4, 1)
    domainLo = Math.max(lo - span, 0)
    domainHi = lo + span * 1.5
  }
  const range = Math.max(domainHi - domainLo, 1e-6)
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - domainLo) / range) * 100))

  const bandStart = pct(lo)
  const bandEnd = hasMax ? pct(hi) : 100
  const valuePos = pct(value)
  // 0 = control not made yet, so no needle. Any non-zero reading shows —
  // including negative stab values (shrinkage).
  const centered = hasMax && lo < 0 && hi > 0
  const showNeedle = value !== 0
  const needleColor = conform === false ? 'bg-destructive' : conform === true ? 'bg-green-600' : 'bg-zinc-400'

  return (
    <div className="mt-1.5">
      <div className="relative h-1.5 rounded-full bg-zinc-200">
        {/* Acceptable band */}
        <div
          className="absolute inset-y-0 rounded-full bg-green-500/30"
          style={{ left: `${bandStart}%`, right: `${100 - bandEnd}%` }}
        />
        {/* Band-edge ticks */}
        <div className="absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-green-600/40" style={{ left: `${bandStart}%` }} />
        {hasMax && (
          <div className="absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-green-600/40" style={{ left: `${bandEnd}%` }} />
        )}
        {/* Center (0) tick on symmetric bands — the neutral, no-deformation point */}
        {centered && (
          <div className="absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 bg-zinc-400" style={{ left: `${pct(0)}%` }} />
        )}
        {/* Value needle */}
        {showNeedle && (
          <div
            className={cn('absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card', needleColor)}
            style={{ left: `${valuePos}%` }}
          />
        )}
      </div>
      {/* Bound labels under the band edges */}
      <div className="relative mt-1 h-3 text-[10px] tabular-nums text-muted-foreground">
        {hasMax ? (
          <>
            <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${bandStart}%` }}>{fmtNum(lo, dec)}</span>
            {centered && (
              <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(0)}%` }}>0</span>
            )}
            <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${bandEnd}%` }}>
              {centered ? `+${fmtNum(hi, dec)}` : fmtNum(hi, dec)}
            </span>
          </>
        ) : (
          <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${bandStart}%` }}>≥ {fmtNum(lo, dec)}</span>
        )}
      </div>
    </div>
  )
}

function ControlesTab({
  detail,
  isEditing,
  edit,
  onEditField,
}: {
  detail: SuiviLotDetail
  isEditing: boolean
  edit: EditState | null
  onEditField: <K extends keyof EditState>(key: K, value: string) => void
}) {
  // Only flag conformity when a ref_fini is attached (otherwise there's nothing
  // to compare against and stab would falsely flag any shrinkage as non-conforme).
  const bounds = detail.reference ? detail.ref_bounds : undefined
  const controles = detail.controles ?? { ennoblisseur: true, malterre: true }
  return (
    <>
      {/* Sous-Traitant */}
      <SidebarCard title="Sous-Traitant" icon={<Factory className="h-3.5 w-3.5 text-accent" />} highlight={isEditing} aside={controles.ennoblisseur ? null : <SansControle qui="ennoblisseur" />}>
        <KVNum label="Laize" field="laize_sst" detailVal={detail.laize_sst} conformKind="laize" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Poids" field="poids_sst" detailVal={detail.poids_sst} conformKind="poids" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Stab H" field="stabH_sst" detailVal={detail.stabH_sst} conformKind="stabH" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Stab L" field="stabL_sst" detailVal={detail.stabL_sst} conformKind="stabL" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
      </SidebarCard>

      {/* Tirelle */}
      <SidebarCard title="Tirelle" icon={<Ruler className="h-3.5 w-3.5 text-accent" />} highlight={isEditing} aside={controles.malterre ? null : <SansControle qui="Malterre" />}>
        <KVNum label="Laize" field="laize_tirelle" detailVal={detail.laize_tirelle} conformKind="laize" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Poids" field="poids_tirelle" detailVal={detail.poids_tirelle} conformKind="poids" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Stab H" field="stabH_tirelle" detailVal={detail.stabH_tirelle} conformKind="stabH" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
        <KVNum label="Stab L" field="stabL_tirelle" detailVal={detail.stabL_tirelle} conformKind="stabL" bounds={bounds} isEditing={isEditing} edit={edit} onEditField={onEditField} />
      </SidebarCard>

      {/* Observations + emplacement + archivage */}
      <SidebarCard title="Observations" icon={<ClipboardCheck className="h-3.5 w-3.5 text-accent" />} highlight={isEditing}>
        {isEditing && edit ? (
          <textarea
            rows={4}
            value={edit.observations}
            onChange={(e) => onEditField('observations', e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : detail.observations?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.observations}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucune observation</p>
        )}
        <div className="mt-3 space-y-1.5">
          <KV
            label="Emplacement"
            value={
              isEditing && edit ? (
                <input
                  type="text"
                  value={edit.emplacement_tirelle}
                  onChange={(e) => onEditField('emplacement_tirelle', e.target.value)}
                  className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[160px]"
                />
              ) : (
                detail.emplacement_tirelle || '—'
              )
            }
          />
          <KV
            label="Fin d'archivage"
            value={
              isEditing && edit ? (
                <input
                  type="date"
                  value={edit.fin_archivage}
                  onChange={(e) => onEditField('fin_archivage', e.target.value)}
                  className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[160px]"
                />
              ) : detail.fin_archivage ? (
                formatHfsqlDate(detail.fin_archivage)
              ) : (
                '—'
              )
            }
          />
        </div>
      </SidebarCard>
    </>
  )
}

function SidebarCard({ title, icon, highlight, aside, children }: { title: string; icon: React.ReactNode; highlight?: boolean; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border bg-card p-3 shadow-sm', highlight && editCardClass)}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

/** Neutral chip: the lot's reference does not ask this control (Finis ›
 *  Références › Informations) — nothing to measure, nothing to chase. */
function SansControle({ qui }: { qui: string }) {
  return (
    <span
      className="ml-auto rounded-full border border-border/60 bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`La référence ne demande pas de contrôle ${qui} (Finis › Références › Informations) : aucune mesure n’est attendue.`}
    >
      Sans contrôle {qui} (réf.)
    </span>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-[1.75rem]">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

function KVNum({
  label,
  field,
  detailVal,
  dec = 0,
  isEditing,
  edit,
  onEditField,
  conformKind,
  bounds,
  rdtBounds,
}: {
  label: string
  field: keyof EditState
  detailVal: number
  dec?: number
  isEditing: boolean
  edit: EditState | null
  onEditField: <K extends keyof EditState>(key: K, value: string) => void
  conformKind?: ConformKind
  bounds?: RefBounds
  rdtBounds?: Tolerance
}) {
  // Conformity is computed off the live value: the edited string while editing,
  // the saved value otherwise — so the marker + gauge update as the user types.
  const currentVal = isEditing && edit ? Number(edit[field]) || 0 : detailVal
  const tol = conformKind ? resolveTolerance(conformKind, bounds, rdtBounds) : null
  const conform = tol ? checkConform(currentVal, tol) : null
  return (
    <div className="min-h-[1.75rem]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="inline-flex items-center justify-end gap-1.5">
          <ConformMarker conform={conform} />
          {isEditing && edit ? (
            <input
              type="number"
              step="any"
              value={edit[field]}
              onChange={(e) => onEditField(field, e.target.value)}
              className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[110px] tabular-nums"
            />
          ) : (
            <span className="tabular-nums text-sm">{detailVal === 0 ? '' : fmtNum(detailVal, dec)}</span>
          )}
        </span>
      </div>
      {tol && <ToleranceGauge value={currentVal} tol={tol} conform={conform} dec={dec} />}
    </div>
  )
}

// ── Documents tab (read-only, reuses commande-sst endpoints) ──

function DocumentsTab({ commandeId }: { commandeId: number }) {
  const [viewDoc, setViewDoc] = useState<DocRow | null>(null)
  const { data: docs, isLoading } = useQuery({
    queryKey: ['suivi-lot-docs', commandeId],
    queryFn: () => apiFetch<DocRow[]>(`/commandes-sous-traitant/${commandeId}/documents`),
    enabled: commandeId > 0,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      </div>
    )
  }
  if (!docs || docs.length === 0) {
    return <p className="text-sm text-muted-foreground italic">Aucun document</p>
  }
  return (
    <>
      {docs.map((d) => (
        <button
          key={d.IDged}
          type="button"
          onClick={() => setViewDoc(d)}
          className="w-full text-left p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors"
        >
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-accent flex-shrink-0" />
            <span className="text-sm font-medium truncate flex-1">{d.nom || `Document #${d.IDged}`}</span>
          </div>
          {!!d.type_nom && <p className="text-[11px] text-muted-foreground mt-1 ml-6">{d.type_nom}</p>}
          {!!d.commentaire?.trim() && <p className="text-[11px] text-muted-foreground mt-0.5 ml-6 truncate">{d.commentaire}</p>}
        </button>
      ))}
      <DocViewDialog doc={viewDoc} commandeId={commandeId} onClose={() => setViewDoc(null)} />
    </>
  )
}

function DocViewDialog({ doc, commandeId, onClose }: { doc: DocRow | null; commandeId: number; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)
  const url = doc ? `${API_URL}/commandes-sous-traitant/${commandeId}/documents/${doc.IDged}/fichier` : ''

  useEffect(() => {
    if (!doc) { setFichierOk(null); return }
    let cancelled = false
    fetch(url, { method: 'HEAD', credentials: 'include' })
      .then((r) => { if (!cancelled) setFichierOk(r.ok) })
      .catch(() => { if (!cancelled) setFichierOk(false) })
    return () => { cancelled = true }
  }, [doc, url])

  if (!doc) return null
  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[90vh]" onClick={(e) => e.stopPropagation()}>
          <iframe src={`${url}#view=FitH`} className="w-full h-full rounded-lg" title={doc.nom ?? 'Document'} />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FileText className="h-12 w-12 opacity-30 mb-2" />
            <p className="text-sm">{fichierOk === null ? 'Chargement…' : 'Aucun document attaché'}</p>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ── Roll quality history (icon + hover tooltip on a piece row) ──────

// One hue per quality stage so the user reads the source at a glance.
const QUALITY_SOURCE_META: Record<string, { dot: string; text: string }> = {
  Tricotage: { dot: 'bg-amber-500', text: 'text-amber-700' },
  'Défaut tricotage': { dot: 'bg-amber-600', text: 'text-amber-800' },
  Ennoblisseur: { dot: 'bg-sky-500', text: 'text-sky-700' },
  'Contrôle fini': { dot: 'bg-teal-500', text: 'text-teal-700' },
}

function QualityHistoryCell({ numero, quality }: { numero: string; quality: QualityEntry[] }) {
  if (quality.length === 0) return null
  // Any "Défaut*" entry → flag the icon as a defect (amber triangle), else a comment bubble.
  const hasDefaut = quality.some((q) => q.source.toLowerCase().startsWith('défaut'))
  const Icon = hasDefaut ? AlertTriangle : MessageSquare
  return (
    <Tooltip
      side="left"
      content={
        <div className="w-64 space-y-2 py-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Historique qualité — {numero}
          </p>
          <ul className="space-y-1.5">
            {quality.map((q, i) => {
              const meta = QUALITY_SOURCE_META[q.source] ?? { dot: 'bg-zinc-400', text: 'text-zinc-600' }
              return (
                <li key={i} className="flex gap-1.5">
                  <span className={cn('mt-1 h-1.5 w-1.5 rounded-full flex-shrink-0', meta.dot)} />
                  <div className="min-w-0">
                    <span className={cn('text-[11px] font-semibold', meta.text)}>{q.source}</span>
                    {!!q.author && <span className="text-[11px] text-muted-foreground"> · {q.author}</span>}
                    <p className="text-xs text-foreground whitespace-pre-line break-words">{q.text}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      }
    >
      <Icon className={cn('h-3.5 w-3.5 cursor-pointer', hasDefaut ? 'text-amber-600' : 'text-accent')} aria-label="Historique qualité" />
    </Tooltip>
  )
}

// ── Défauts tab ──────────────────────────────────────────

function DefautsTab({ lotId }: { lotId: number }) {
  const { data: defauts, isLoading } = useQuery({
    queryKey: ['suivi-lot-defauts', lotId],
    queryFn: () => apiFetch<DefautRow[]>(`/suivi-lots/${lotId}/defauts`),
    enabled: lotId > 0,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      </div>
    )
  }
  if (!defauts || defauts.length === 0) {
    return <p className="text-sm text-muted-foreground italic">Aucun défaut signalé</p>
  }
  return (
    <>
      {defauts.map((d) => (
        <div key={d.IDdefaut_qualite} className="p-3 rounded-lg border-l-4 border-l-destructive/60 border bg-card shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-destructive/70 flex-shrink-0" />
            <span className="text-sm font-medium truncate flex-1">{d.type_defaut || 'Défaut'}</span>
            {!!d.roll_numero && <Badge variant="secondary" className="text-[10px] py-0">{d.roll_numero}</Badge>}
          </div>
          {!!d.description?.trim() && <p className="text-[11px] text-muted-foreground mt-1 ml-5">{d.description}</p>}
          <div className="flex items-center gap-3 mt-1.5 ml-5 text-[11px] text-muted-foreground">
            {d.taille_cm > 0 && <span>{fmtNum(d.taille_cm)} cm</span>}
            {d.nombre > 0 && <span>×{d.nombre}</span>}
            {!!d.date && <span className="ml-auto">{formatHfsqlDate(d.date)}</span>}
          </div>
        </div>
      ))}
    </>
  )
}

// ── Client tab ───────────────────────────────────────────

// ── Reprises (lib/reprises.ts on the API) ────────────────
//
// A reprise is data since 2026-10-12: the lot keeps the dyer's number, each
// return to the dyer is a row (who, when, why, back when). Historical ones
// come from the old « R » suffixes, undated.

function fmtDateHeure(iso: string | null): string {
  if (!iso) return ''
  const [d, h] = iso.split('T')
  const [y, m, j] = d.split('-')
  return h ? `${j}/${m}/${y} ${h}` : `${j}/${m}/${y}`
}

function ReprisesCard({ reprises }: { reprises: RepriseLot[] }) {
  if (reprises.length === 0) return null
  return (
    <div className="rounded-xl border bg-card shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <RotateCcw className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Reprises chez l’ennoblisseur</h2>
        <Badge variant="secondary" className="text-xs ml-auto">{reprises.length}</Badge>
      </div>
      <div className="space-y-2">
        {reprises.map((r) => {
          const ouverte = r.statut === 'ouverte'
          return (
            <div
              key={r.id}
              className={cn(
                'rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
                ouverte ? 'border-l-orange-500/60' : 'border-l-border',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', ouverte ? 'bg-orange-500/10' : 'bg-muted')}>
                    <RotateCcw className={cn('h-3.5 w-3.5', ouverte ? 'text-orange-600' : 'text-muted-foreground')} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">Reprise n° {r.rang}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {r.rouleaux} rouleau{r.rouleaux > 1 ? 'x' : ''}
                      {r.origine === 'historique' && r.lot_saisi ? ` · saisie « ${r.lot_saisi} » avant ETM` : ''}
                    </p>
                  </div>
                </div>
                {ouverte
                  ? <Badge variant="outline" className="text-[10px] py-0 border-orange-200 bg-orange-100 text-orange-800">Chez l’ennoblisseur</Badge>
                  : <Badge variant="outline" className="text-[10px] py-0">Revenue</Badge>}
              </div>
              {r.motif?.trim() && (
                <div className="flex items-start gap-1.5 mt-2 ml-9">
                  <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                  <p className="text-[11px] text-muted-foreground italic">{r.motif.trim()}</p>
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 ml-9 text-[11px] text-muted-foreground flex-wrap">
                {r.origine === 'historique'
                  ? <span>Date inconnue (lot suffixé à la main)</span>
                  : (
                    <>
                      {r.envoye_le && <span>Envoyée le {fmtDateHeure(r.envoye_le)}{r.envoye_par ? ` par ${r.envoye_par}` : ''}</span>}
                      {r.retour_le && <span>Revenue le {fmtDateHeure(r.retour_le)}{r.retour_par ? ` par ${r.retour_par}` : ''}</span>}
                    </>
                  )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** « Reprendre »: the motif is asked before the lot goes back to the dyer. */
function RepriseMotifDialog({
  open, lot, isPending, error, initialMotif = '', avecNature = false, initialNature = 'rame', onCancel, onConfirm,
}: {
  open: boolean
  lot: string
  isPending: boolean
  error: string | null
  /** A refused soumission pre-fills the client's reason. */
  initialMotif?: string
  /** Ask whether the lot goes back on the stenter or back to the dye (LIVA #1313):
   *  only where the client checks the coloris — a re-dye asks it again. */
  avecNature?: boolean
  initialNature?: 'rame' | 'teinture'
  onCancel: () => void
  onConfirm: (motif: string, nature: 'rame' | 'teinture') => void
}) {
  const [motif, setMotif] = useState('')
  const [nature, setNature] = useState<'rame' | 'teinture'>('rame')
  useEffect(() => { if (open) { setMotif(initialMotif); setNature(initialNature) } }, [open, initialMotif, initialNature])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <DialogContent className="max-w-md" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-accent" />
            Reprendre le lot {lot}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {avecNature && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Le lot repart</label>
              <div className="flex gap-1">
                {([['rame', 'En rame'], ['teinture', 'En teinture']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setNature(k)}
                    className={cn(
                      'flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors',
                      nature === k
                        ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium'
                        : 'text-muted-foreground border-border hover:bg-accent/10',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {nature === 'teinture' && (
                <p className="text-[11px] text-muted-foreground">Le coloris sera soumis à nouveau au client au retour du lot.</p>
              )}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Motif de la reprise</label>
            <textarea
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Teinte hors tolérance, laize trop étroite…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Les rouleaux du lot encore en stock partent en reprise. Le lot garde le numéro de l’ennoblisseur : ETM enregistre la reprise, n’ajoutez pas de « R ».
          </p>
          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>Annuler</Button>
          <Button onClick={() => onConfirm(motif.trim(), avecNature ? nature : 'rame')} disabled={!motif.trim() || isPending}>
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />}
            Reprendre
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Status footer (multi-state état pill) ────────────────

// Action verbs for the two manual transitions (target état → verb).
const ETAT_ACTION_LABEL: Record<3 | 2, string> = { 3: 'Valider', 2: 'Reprendre' }

function EtatFooter({
  current,
  canManage,
  onChange,
  isChanging,
  disabled,
}: {
  current: Etat
  canManage: boolean
  onChange: (next: Etat) => void
  isChanging: boolean
  disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = ETAT_META[current]
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
    if (disabled || !canManage) setMenuOpen(false)
  }, [disabled, canManage])

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solidBg)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        {/* Read-only for non-responsables: pill only, no verdict control. */}
        {canManage && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={disabled || isChanging}
            title="Changer le statut"
            className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
          >
            {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
            Changer
          </button>
        )}
      </div>
      {canManage && menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {ETAT_ACTIONS.map((s) => {
            const m = ETAT_META[s]
            const active = current === s // already in this state → non-actionable
            const SIcon = m.icon
            return (
              <button
                key={s}
                type="button"
                disabled={active}
                onClick={() => {
                  if (!active) onChange(s)
                  setMenuOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                  active ? 'bg-accent/10 text-accent cursor-default' : 'hover:bg-zinc-100',
                )}
              >
                <SIcon className={cn('h-4 w-4', active ? 'text-accent' : m.iconColor)} />
                {ETAT_ACTION_LABEL[s as 3 | 2]}
                {active && <CheckCircle2 className="h-4 w-4 ml-auto text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
