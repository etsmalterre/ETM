// Sous-traitants / Commandes — Phase 1.
//
// Mirrors `FilsCommandes.tsx` for the master-detail / sidebar / unsaved-guard
// machinery. Specific to this screen:
//   - header status is `est_soldee` BOOLEAN (not commande_fil's `etat` int)
//   - per-line status is the legacy string `sstatut` — Phase 1 binary toggle
//     maps to the literal values 'En_Cours' / 'Terminé'
//   - lines reference ref_ecru / colori_ecru (Phase 1 = ennoblisseur flow)
//   - no mode_paiement / echeance fields (don't exist on the entity)
//   - line drawer is the "pièces" drawer:
//       * affecter: link existing stock_ecru (tombé-de-métier rolls) to the line
//       * réception: record stock_fini rolls returned dyed
//   - "Délai initial" indicator on each line when date_delai !== date_livraison
//   - Phase 1 gates create + line CRUD to **Ennoblisseur** sous-traitants only;
//     existing non-ennoblisseur commandes remain readable.

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  ShoppingCart,
  Building2,
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
  AlertTriangle,
  CheckCircle2,
  Clock,
  Package,
  Link2,
  Unlink,
  Printer,
  AtSign,
  Send,
  FileText,
  Upload,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  RotateCcw,
  Truck,
  HelpCircle,
  Mail,
  Hourglass,
  Scissors,
  BellRing,
  Factory,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useResponsiveLayout } from '@/hooks/useResponsiveLayout'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { RollNotes } from '@/components/shared/RollNotes'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateLotQualityCaches } from '@/lib/cache-sync'
import { postEmail } from '@/lib/email'
import { sstTypeTagClasses } from '@/lib/sst-type'

// ── Constants ──────────────────────────────────────────

const TYPE_ENNOBLISSEUR = 'Ennoblisseur'
const SSTATUT_OPEN = 'En_Cours'
const SSTATUT_DONE = 'Terminé'

// IDtype_sst values from production: 1 Tricoteur, 2 Ennoblisseur, 3 Autre,
// 4 Confectionneur. The PopoverSelect for "Type sous-traitant" is keyed on
// these ids. Phase 1 only lists Ennoblisseur; the others land in Phase 2
// once their drawer flows are built.
const TYPE_SST_ID_BY_LABEL: Record<string, number> = {
  Tricoteur: 1,
  Ennoblisseur: 2,
  Autre: 3,
  Confectionneur: 4,
}
const TYPE_SST_LABEL_BY_ID: Record<number, string> = {
  1: 'Tricoteur',
  2: 'Ennoblisseur',
  3: 'Autre',
  4: 'Confectionneur',
}
const TYPE_SST_OPTIONS_PHASE1: Array<{ id: number; primary: string }> = [
  { id: TYPE_SST_ID_BY_LABEL.Ennoblisseur, primary: 'Ennoblisseur' },
  // Phase 2: Tricoteur is wired with a backend bridge that auto-mirrors
  // the commande as a TRM-side commande_client (see [[project-etm-trm-bridge]]).
  { id: TYPE_SST_ID_BY_LABEL.Tricoteur, primary: 'Tricoteur' },
]

const TYPE_TRICOTEUR = 'Tricoteur'

function isLineDone(sstatut: string | null | undefined): boolean {
  return (sstatut ?? '').trim() === SSTATUT_DONE
}

// ── Types ──────────────────────────────────────────────

interface CommandeListRow {
  IDcommande_sous_traitant: number
  IDsous_traitant: number
  date_commande: string | null
  est_soldee: number | null
  /** Computed phase (server-derived). See PhasePill / SST_PHASE_META. */
  phase: SstPhase
  sous_traitant_nom: string
  sous_traitant_type: string | null
  total_eur: number
  total_qte: number
  nb_lignes: number
  earliest_delivery: string | null
  /** Most recent bon-de-commande send date for this commande (envoi_email
   *  IDtype_doc=13), as "YYYY-MM-DD" or null. Fallback anchor for the
   *  `attente_delai` urgency frame when `date_notif` is unset. */
  bon_envoye_at: string | null
  /** Relance date (`commande_sous_traitant.date_notif`, HFSQL YYYYMMDD or
   *  null). Primary anchor for the `attente_delai` urgency frame — see
   *  `attenteDelaiUrgency`. */
  date_notif: string | null
}

interface LigneCommande {
  IDligne_commande_sous_traitant: number
  IDcommande_sous_traitant: number
  type: number | null
  IDreference: number | null
  IDColoris: number | null
  quantite: number | null
  unite: number | null
  prix: number | null
  date_livraison: string | null
  date_delai: string | null
  date_reception: string | null
  commentaire: string | null
  sstatut: string | null
  num_facture: string | null
  ref_label: string | null
  ref_kind: 'ecru' | 'fini' | 'fil' | null
  // `ref_fini.rendement` in Ml/kg — used to compute "Ml potentiel" =
  // total_kg_ecru_lie × rendement once écru rolls are attached. 0 means
  // either not a fini line or the catalog has no rendement on file.
  ref_rendement?: number
  colori_reference: string | null
  // Drawer-fed per-line aggregates. The line's actual € total is
  // `total_kg_ecru_lie × prix` (the user-entered prix is €/Kg, applied to
  // the real attached weight, not the nominal qty in Ml).
  nb_ecru_lies?: number
  total_kg_ecru_lie?: number
  nb_fini_recu?: number
  total_metrage_fini_recu?: number
  /** Per-lot breakdown of the received fini rolls (empty lot groups under
   *  ''). Feeds the "Ml reçus" tooltip in the totals footer. */
  fini_lots?: Array<{ lot: string; nb: number; metrage: number }>
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
  IDcommande_sous_traitant: number
  IDsous_traitant: number
  date_commande: string | null
  est_soldee: number | null
  commentaire: string | null
  journal: string | null
  IDadresse_sous_traitant: number | null
  IDadresse_livraison: number | null
  sous_traitant_nom: string
  sous_traitant_tel: string | null
  sous_traitant_type: string | null
  sous_traitant_IDtype_sst: number
  adresse_sous_traitant: AdresseLite | null
  adresse_livraison: AdresseLite | null
  lignes: LigneCommande[]
  /** True when this commande's sous-traitant has rows in
   *  `tranche_tarif_ennoblissement`. Drives the read-only lock on the
   *  prix input — suppliers without a catalog (e.g. FRANCE TEINTURE)
   *  keep manual prix entry instead. */
  auto_pricing_enabled?: boolean
  /** Computed phase (server-derived). See PhasePill / SST_PHASE_META. */
  phase: SstPhase
  /** Most recent bon-de-commande send date (envoi_email IDtype_doc=13),
   *  "YYYY-MM-DD" or null. Drives the "Attente depuis X jours" label on
   *  Attente_Delai lines, and is the fallback urgency anchor. */
  bon_envoye_at: string | null
  /** Relance date (`date_notif`, HFSQL YYYYMMDD or null). Editable in the
   *  Info tab; primary anchor for the Attente_Delai urgency colour. */
  date_notif: string | null
  /** Set only when this sst targets Tricotage Malterre (the sister
   *  company). Carries the mirrored TRM `commande_client` row + a
   *  produced-rolls tally derived from stock_ecru.IDref_commande_source
   *  pointing at this sst's lines. Null on every other ennoblisseur /
   *  external tricoteur / confectionneur. */
  trm_mirror: TrmMirror | null
}

interface TrmMirror {
  IDcommande_client: number
  numero: number | null
  date_commande: string | null       // HFSQL YYYYMMDD
  ref_client: string | null
  est_soldee: number                 // 0/1
  rolls_produced: number
  poids_produced_kg: number
}

interface SousTraitantLite {
  IDsous_traitant: number
  nom: string
  tel: string | null
  IDtype_sst: number | null
  type: string | null
}

interface RefFiniLookup {
  IDref_fini: number
  ref_fini: string
  designation: string
}

interface RefEcruLookup {
  IDref_ecru: number
  ref_ecru: string
  designation: string
  /** ref_ecru.prix (€/kg). Used to auto-fill the tricoteur line prix when
   *  the user picks a ref — the backend would default it anyway, but
   *  showing the value in the form makes the cost visible up front. */
  prix: number
}

interface AdresseLookup extends AdresseLite {
  est_defaut: number
  est_defaut_facturation: number
  est_defaut_livraison: number
}

interface MagasinLite {
  IDmagasin: number
  nom: string
}

// Pieces drawer payload
/** Quality defect logged in the legacy `defaut_qualite` table. Multiple
 *  defects can be recorded per écru roll. The combo of `description`
 *  (precise human-readable) + `type_defaut` (category) + `taille_cm`
 *  size lets the UI render each defect as a structured red bullet
 *  inside the defect banner. */
interface DefautQualite {
  IDdefaut_qualite: number
  description: string | null
  type_defaut: string | null
  taille_cm: number | null
}

interface StockEcruLite {
  IDstock_ecru: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  IDref_ecru: number
  IDcolori_ecru: number
  IDmagasin: number
  IDordre_fabrication: number
  date_saisie: string | null
  /** Textile industry quality flag — >0 means the roll is downgraded
   *  ("second choix"). Surfaced as a destructive badge on the card. */
  second_choix: number | null
  /** Free-text inspection note captured by the visiteur (qualité
   *  inspector). Rendered as an italic line under the card. */
  observations: string | null
  /** Structured defects from `defaut_qualite` — rendered inside the
   *  red "Défaut" banner alongside `observations`. */
  defects?: DefautQualite[]
  // Customer reservation — populated only on linked rolls. See server-side
  // comment on the same field for the full join chain.
  IDligne_commande_client?: number
  client_nom?: string | null
}
interface StockFiniLite {
  IDstock_fini: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  IDref_fini: number
  IDColoris: number
  IDstock_ecru: number
  IDmagasin: number
  date_saisie: string | null
  /** Same semantic as on écru — >0 = second choix. */
  second_choix: number | null
  /** Visiteur's note at reception. */
  observations: string | null
  /** Ennoblisseur's note (separate from the visiteur's). Surfaced as a
   *  second italic line so the source of each comment stays clear. */
  observation_sst: string | null
  /** Workflow state — labels from etat_stock_fini:
   *    1=En Contrôle, 2=En Reprise, 3=Validé, 4=Expédié, 5=Attente de décision. */
  IDetat_stock_fini: number | null
  /** Resolved client name when the fini is reserved to a client order —
   *  inherited from the source écru's `IDligne_commande_client` at
   *  reception time. Shown as a `Building2` badge on the card. */
  client_nom?: string | null
}
interface PiecesPayload {
  ecruLinked: StockEcruLite[]
  ecruAvailable: StockEcruLite[]
  finiReceived: StockFiniLite[]
  /** The line's `prix` (€/Kg) after any auto-recalc triggered by the
   *  link/unlink mutation that produced this payload. Mirrors what the
   *  server-side `recalcLignePrix` just wrote to HFSQL. Used to patch the
   *  commande detail React Query cache so the LineCard re-renders with
   *  the new value without a full refetch. */
  prix: number
}

// Read-only payload for the tricoteur (type=1) line drawer. Mirrors the
// server's GET /:id/lignes/:lid/pieces-fil response. The drawer shows two
// tabs: Réception (écru produced by the knitter, affected to this line)
// and Stock fil (every yarn roll of this ref_fil — full availability
// view, no filter on coloris/fournisseur/magasin).
interface StockFilLite {
  IDstock_fil: number
  IDref_fil: number
  IDcolori_fil: number | null
  IDfournisseur: number | null
  IDMagasin: number | null
  IDref_fil_commande: number | null
  stock: number | null
  lot: string | null
  lot_frs: string | null
  emplacement: string | null
  date_entree: string | null
  ref_fil_reference?: string | null
  colori_reference?: string | null
  fournisseur_nom?: string | null
  magasin_nom?: string | null
  /** Kg of this lot currently affected to the line via asso_fil_lignecmdsst.
   *  0 means not affected. > 0 puts an "affecté X kg" chip on the row. */
  affecte_kg?: number
}

interface TricoteurAffectationRow {
  IDasso_fil_ligneCmdSST: number
  IDstock_fil: number
  IDligne_commande_sous_traitant: number
  quantite: number
}

interface TricoteurCompositionPair {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: number
  ref_fil_reference: string | null
  colori_reference: string | null
}

interface TricoteurPiecesPayload {
  ecruProduced: StockEcruLite[]
  stockFil: StockFilLite[]
  /** The line's quantite (kg of écru to produce). Surfaced so buttons can
   *  show "Affecter (1234 kg)" without a separate detail fetch. */
  targetQtyKg: number
  /** Active asso_fil_lignecmdsst rows for this line. When non-empty, the
   *  Stock fil tab shows "Désaffecter" instead of Affecter/Finir. */
  affectations: TricoteurAffectationRow[]
  /** Required composition pairs for this line's écru — every pair must
   *  have at least one selected lot before Affecter/Finir enable. */
  compositionPairs: TricoteurCompositionPair[]
}

// Returned by GET /:id/soumission/lots-eligibles. One entry per
// (ref_fini, coloris, lot, commande_client) group; only includes groups
// whose (client, ref_fini) pair has designation_client.soumettre = 1.
interface EligibleLot {
  /** 'received' = lot string is already known from received fini rolls;
   *  'manual' = no fini received yet, écru affectations identify the
   *  client, user types the lot at picker time. */
  kind: 'received' | 'manual'
  IDref_fini: number
  IDColoris: number
  lot: string                  // '' for manual
  IDcommande_client: number
  IDclient: number
  client_nom: string
  ref_malterre: string
  client_designation: string
  coloris_reference: string
  numero: number               // commande_client.numero
  date_commande: string        // commande_client.date_commande (YYYYMMDD)
  nb_rolls: number             // 0 for manual
  total_metrage: number        // 0 for manual
  key: string
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// Build a PopoverSelect option for an adresse: name on top + collapsed
// "street · cp ville · pays" descriptor below so the user can verify the
// pick at a glance from the dropdown.
function adresseOption(a: AdresseLookup) {
  const street = [a.adresse1, a.adresse2, a.adresse3].filter((s) => !!s && s.trim()).join(' · ')
  const cityLine = [a.cp, a.ville].filter((s) => !!s && s.toString().trim()).join(' ')
  const descLines = [street, cityLine, a.pays || '']
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
  return {
    id: a.IDadresse,
    primary: a.nom || `Adresse #${a.IDadresse}`,
    secondary: a.ville ?? undefined,
    description: descLines.length > 0 ? descLines.join('\n') : undefined,
  }
}

// ── Status helpers ─────────────────────────────────────

/** Computed phase, served by the API in the list + detail responses.
 *  Replaces the old binary "en cours / terminée" pill — derived from
 *  est_soldee + stock_fini.IDetat_stock_fini + envoi_email history + line
 *  sstatut state machine (Non_Envoye → Attente_Delai → En_Cours). See
 *  `commandes-sous-traitant.ts` `computePhase` for the server logic. */
export type SstPhase =
  | 'non_envoye'
  | 'attente_delai'
  | 'en_cours'
  | 'en_controle'
  | 'soumis'
  | 'en_reprise'
  | 'terminee'

/** Filter keys accepted by the list endpoint. The toggle bar exposes only
 *  the macro buckets ('open' / 'terminee' / 'all'); sub-phase narrowing
 *  happens via the search bar (server matches phase keywords). The full
 *  SstPhase set is still accepted so a phase keyword can fall through. */
export type StatusFilter = SstPhase | 'all' | 'open'

const SST_PHASE_META: Record<SstPhase, {
  label: string
  icon: typeof Clock
  /** Solid background + border, white text. Shared by the StatusFooter
   *  band and the left-list card pill so the two always match (§29.8). */
  solid: string
}> = {
  non_envoye:    { label: 'Non envoyé',        icon: Mail,         solid: 'bg-slate-500 border-slate-500' },
  attente_delai: { label: 'Attente délai',     icon: Hourglass,    solid: 'bg-yellow-500 border-yellow-500' },
  en_cours:      { label: 'En cours',          icon: Clock,        solid: 'bg-primary border-primary' },
  en_controle:   { label: 'En contrôle',       icon: Eye,          solid: 'bg-amber-500 border-amber-500' },
  soumis:        { label: 'Soumis au client',  icon: Send,         solid: 'bg-violet-500 border-violet-500' },
  en_reprise:    { label: 'En reprise',        icon: RotateCcw,    solid: 'bg-orange-500 border-orange-500' },
  terminee:      { label: 'Terminée',          icon: CheckCircle2, solid: 'bg-success border-success' },
}

function PhasePill({ phase, className }: { phase: SstPhase | null | undefined; className?: string }) {
  const meta = SST_PHASE_META[phase ?? 'en_cours']
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solid, className)}>
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </Badge>
  )
}

function deliveryUrgency(earliestHfsql: string | null, est_soldee: number | null): 'late' | 'soon' | null {
  if (est_soldee === 1) return null
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

/** Whole days a YYYYMMDD delivery deadline is past today. Returns 0 when
 *  the deadline is today or in the future. */
function deliveryOverdueDays(hfsql: string): number {
  if (!/^\d{8}$/.test(hfsql)) return 0
  const y = Number(hfsql.slice(0, 4))
  const m = Number(hfsql.slice(4, 6)) - 1
  const d = Number(hfsql.slice(6, 8))
  const target = new Date(y, m, d)
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000)
  return diff > 0 ? diff : 0
}

/** A copy of `base` advanced by `n` working days (Sat/Sun skipped).
 *  French bank holidays are intentionally NOT considered — they vary per
 *  year and per company. Result is normalised to midnight. */
function addWorkingDays(base: Date, n: number): Date {
  const r = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  let added = 0
  while (added < n) {
    r.setDate(r.getDate() + 1)
    const dow = r.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return r
}

/** Urgency frame for commandes in `attente_delai`, anchored on the
 *  `date_notif` relance date: red on the relance day and after, amber on
 *  the last working day before it (so a Monday relance turns the card
 *  amber on Friday, not over the weekend), no frame earlier. When
 *  `date_notif` is unset (legacy commandes), the relance date falls back
 *  to the bon de commande send date + 3 working days. Returns null when
 *  neither anchor is known.
 *
 *  dateNotifHfsql: "YYYYMMDD" relance date, or null.
 *  isoSentDay: "YYYY-MM-DD" (envoi_email.DATE truncated), fallback anchor. */
function attenteDelaiUrgency(
  dateNotifHfsql: string | null,
  isoSentDay: string | null,
): 'late' | 'soon' | null {
  let notif: Date | null = null
  if (dateNotifHfsql && /^\d{8}$/.test(dateNotifHfsql)) {
    notif = new Date(
      Number(dateNotifHfsql.slice(0, 4)),
      Number(dateNotifHfsql.slice(4, 6)) - 1,
      Number(dateNotifHfsql.slice(6, 8)),
    )
    notif.setHours(0, 0, 0, 0)
  } else if (isoSentDay && /^\d{4}-\d{2}-\d{2}$/.test(isoSentDay)) {
    const sent = new Date(
      Number(isoSentDay.slice(0, 4)),
      Number(isoSentDay.slice(5, 7)) - 1,
      Number(isoSentDay.slice(8, 10)),
    )
    notif = addWorkingDays(sent, 3)
  }
  if (!notif) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (notif.getTime() <= today.getTime()) return 'late'
  if (notif.getTime() <= addWorkingDays(today, 1).getTime()) return 'soon'
  return null
}

/** Whole days elapsed since the bon de commande was sent. `isoDay` is
 *  "YYYY-MM-DD" (envoi_email.DATE truncated). Returns null when no send
 *  date is known, or a clamped count >= 0 otherwise. */
function attenteDelaiDays(isoDay: string | null): number | null {
  if (!isoDay || !/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return null
  const y = Number(isoDay.slice(0, 4))
  const m = Number(isoDay.slice(5, 7)) - 1
  const d = Number(isoDay.slice(8, 10))
  const sent = new Date(y, m, d)
  sent.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((today.getTime() - sent.getTime()) / 86_400_000))
}

function lineEtatColors(sstatut: string | null) {
  if (isLineDone(sstatut)) {
    return {
      border: 'border-l-green-500/60',
      iconBg: 'bg-green-500/10',
      iconColor: 'text-green-600',
    }
  }
  const s = (sstatut ?? '').trim()
  // Non envoyé — slate (neutral, "nothing has happened yet"). Mirrors
  // SST_PHASE_META.non_envoye so the header pill and the line card share
  // the same hue.
  if (s === 'Non_Envoye') {
    return {
      border: 'border-l-slate-400/60',
      iconBg: 'bg-slate-400/10',
      iconColor: 'text-slate-600',
    }
  }
  // Attente délai — yellow (distinct from the en_controle amber).
  if (s === 'Attente_Delai') {
    return {
      border: 'border-l-yellow-500/60',
      iconBg: 'bg-yellow-500/10',
      iconColor: 'text-yellow-700',
    }
  }
  // En_Cours and any other legacy "open" value — blue, matches the
  // primary phase pill.
  return {
    border: 'border-l-blue-500/60',
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-600',
  }
}

function isEnnoblisseurType(type: string | null): boolean {
  if (!type) return false
  return type.trim().toLowerCase() === TYPE_ENNOBLISSEUR.toLowerCase()
}

// Sous-traitant type chip colours live in the shared module (see mps_designer
// §36) so Commandes and Gestion stay visually identical.

// Debounce a fast-changing value (typically a search input). Returns the
// last value that has been stable for `delay` ms. Used to throttle the
// commandes list refetch while the user is still typing.
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// ── Main Page ──────────────────────────────────────────

export function SousTraitantsCommandes() {
  const queryClient = useQueryClient()
  const { isStacked } = useResponsiveLayout()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  // Compact pills (right of the search bar) narrow the open list to
  // attente_delai commandes whose bon de commande is overdue. They are
  // independent toggles — both off means no narrowing, either on hides the
  // rest. When at least one is on the underlying query switches to
  // `attente_delai`; the loaded rows are then further pruned client-side to
  // match the selected urgency bucket(s).
  const [urgencyLateOn, setUrgencyLateOn] = useState(false)
  const [urgencySoonOn, setUrgencySoonOn] = useState(false)
  const urgencyFilterActive = urgencyLateOn || urgencySoonOn
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [piecesDrawerLineId, setPiecesDrawerLineId] = useState<number | null>(null)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteCommandeConfirmOpen, setDeleteCommandeConfirmOpen] = useState(false)
  // Soumission Lot — eligibility-gated workflow that opens the email modal
  // with a freshly-built soumission PDF attached. See plan file.
  const [soumissionPickerOpen, setSoumissionPickerOpen] = useState(false)
  const [soumissionEmailOpen, setSoumissionEmailOpen] = useState(false)
  const [selectedSoumissionLot, setSelectedSoumissionLot] = useState<EligibleLot | null>(null)

  // Edit-mode draft state
  const [editDateCommande, setEditDateCommande] = useState('')
  const [editDateNotif, setEditDateNotif] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')
  const [editJournal, setEditJournal] = useState('')
  const [editIDAdresseSousTraitant, setEditIDAdresseSousTraitant] = useState<number>(0)
  const [editIDAdresseLivraison, setEditIDAdresseLivraison] = useState<number>(0)

  const originalDraftRef = useRef<{
    dateCommande: string
    dateNotif: string
    commentaire: string
    journal: string
    IDadresseSt: number
    IDadresseLiv: number
  } | null>(null)

  // The commande id the current draft was snapshotted from. A header save MUST
  // target this id — never the live `selectedId` — so that if the selection
  // drifts mid-edit (e.g. a list refetch / filter change) the draft can't be
  // written onto a different commande. This is the guard against the
  // sst-9 comment-leak bug (a note typed on one commande landing on another).
  const editingIdRef = useRef<number | null>(null)

  const [linesDirty, setLinesDirty] = useState(false)

  // Keyset-paginated list. The first fetch returns the 100 most recent
  // commandes for the current statusFilter; each subsequent fetch passes
  // the last-seen IDcommande_sous_traitant as `before_id`. Solves the
  // "click 'terminé' → wait forever" problem on this multi-thousand-row
  // table by capping the wire payload at 100 rows per round-trip.
  //
  // When the user types in the search box, we debounce the input (300 ms)
  // and route the query through the same `useInfiniteQuery` but with `q`
  // baked into the key + URL. The backend bypasses pagination for that
  // case so the search scans every matching commande, not just the loaded
  // page. The single page returned is treated as the "last" page (no
  // `getNextPageParam` cursor), so the infinite-scroll logic naturally
  // disables itself while searching.
  const COMMANDES_PAGE_SIZE = 100
  const debouncedSearch = useDebouncedValue(searchQuery.trim(), 200)
  const isSearching = debouncedSearch.length > 0
  // When a pill is on, send `urgency_in=...` to the API so it narrows the
  // result set to matching open commandes across every phase (the rule
  // matches the per-row frame color). The statusFilter stays as the user
  // selected — `terminee` + urgency yields nothing, which the
  // pill/toggle-bar cross-clear UX prevents.
  const urgencyQuery = urgencyFilterActive
    ? `&urgency_in=${[urgencyLateOn ? 'late' : '', urgencySoonOn ? 'soon' : ''].filter(Boolean).join(',')}`
    : ''
  const {
    data: commandesPages,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<CommandeListRow[], Error>({
    queryKey: ['commandes-sst', statusFilter, debouncedSearch, urgencyQuery],
    queryFn: async ({ pageParam }) => {
      if (isSearching) {
        return apiFetch(
          `/commandes-sous-traitant?status=${statusFilter}&q=${encodeURIComponent(debouncedSearch)}${urgencyQuery}`,
        )
      }
      const cursor = typeof pageParam === 'number' && pageParam > 0
        ? `&before_id=${pageParam}` : ''
      return apiFetch(
        `/commandes-sous-traitant?status=${statusFilter}&limit=${COMMANDES_PAGE_SIZE}${cursor}${urgencyQuery}`,
      )
    },
    initialPageParam: 0,
    // While searching, the backend always returns the complete set in one
    // page — never request more. Otherwise a short page (<100) signals
    // end-of-list and a full page advances the cursor to the last id.
    getNextPageParam: (lastPage) => {
      if (isSearching) return undefined
      if (!lastPage || lastPage.length < COMMANDES_PAGE_SIZE) return undefined
      const last = lastPage[lastPage.length - 1]
      return last?.IDcommande_sous_traitant ?? undefined
    },
  })
  const commandes = useMemo<CommandeListRow[] | undefined>(
    () => {
      const flat = commandesPages?.pages.flatMap((p) => p)
      if (!flat) return undefined
      // No urgency pill on → leave the server's ID-DESC order alone.
      if (!urgencyFilterActive) return flat
      // Pills on → server already returned only urgent rows; resort so red
      // (`late`) sits above amber (`soon`), then by ID DESC inside a band.
      const urgencyOf = (row: CommandeListRow) =>
        row.phase === 'attente_delai'
          ? attenteDelaiUrgency(row.date_notif, row.bon_envoye_at)
          : deliveryUrgency(row.earliest_delivery, row.est_soldee)
      const rank = (u: 'late' | 'soon' | null) => (u === 'late' ? 0 : u === 'soon' ? 1 : 2)
      return [...flat].sort((a, b) => {
        const ra = rank(urgencyOf(a))
        const rb = rank(urgencyOf(b))
        if (ra !== rb) return ra - rb
        return b.IDcommande_sous_traitant - a.IDcommande_sous_traitant
      })
    },
    [commandesPages, urgencyFilterActive],
  )

  // Urgency counts — drives the two header pills (number of open commandes
  // currently rendering red / amber across every phase). Polled separately
  // from the list so flipping filters doesn't refetch the counters; the
  // 30 s stale window keeps them live without hammering the API.
  const { data: urgencyCounts } = useQuery<{ late: number; soon: number }>({
    queryKey: ['commandes-sst-urgency-counts'],
    queryFn: () => apiFetch('/commandes-sous-traitant/urgency-counts'),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const { data: detail, isLoading: detailLoading } = useQuery<CommandeDetail>({
    queryKey: ['commande-sst', selectedId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${selectedId}`),
    enabled: selectedId !== null,
  })

  // Soumission Lot eligibility — only fires in view mode for the selected
  // commande. Empty array means the "Soumettre au client" button is hidden.
  const { data: soumissionEligibility } = useQuery<{ lots: EligibleLot[] }>({
    queryKey: ['commande-sst-lots-eligibles', selectedId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${selectedId}/soumission/lots-eligibles`),
    enabled: selectedId !== null && !isEditing,
  })
  const eligibleLots = soumissionEligibility?.lots ?? []

  // Click handler: zero → no-op (button is hidden anyway). A single
  // 'received' candidate skips the picker and goes straight to the email
  // modal; everything else (multiple candidates, or any 'manual' candidate
  // that needs a typed lot string) routes through the picker.
  const onSoumettreClick = useCallback(() => {
    if (eligibleLots.length === 0) return
    if (eligibleLots.length === 1 && eligibleLots[0].kind === 'received') {
      setSelectedSoumissionLot(eligibleLots[0])
      setSoumissionEmailOpen(true)
    } else {
      setSoumissionPickerOpen(true)
    }
  }, [eligibleLots])

  // Auto-select the first row whenever the list filter changes (initial
  // load, status filter switch, or search query update). When the new
  // filter yields zero rows, clear the selection so the detail panel
  // shows its "aucune commande sélectionnée" placeholder.
  //
  // The ref guards against re-triggering on unrelated re-renders — once
  // we've snapped to the first row for a given (statusFilter, search)
  // pair, the user can click any other row without us yanking them back.
  const lastAppliedListKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (commandes === undefined) return
    // Never yank the selection out from under an in-progress edit — that would
    // leave isEditing=true with the draft pointing at a different row. Defer
    // until edit mode ends (isEditing is in the dep list).
    if (isEditing) return
    const key = `${statusFilter}|${debouncedSearch}`
    if (lastAppliedListKey.current === key) return
    lastAppliedListKey.current = key
    // Stacked mode (phone): a null selection IS the list view — never
    // auto-jump into the first row's detail.
    setSelectedId(!isStacked && commandes.length > 0 ? commandes[0].IDcommande_sous_traitant : null)
  }, [commandes, statusFilter, debouncedSearch, isEditing, isStacked])

  // Reset the pieces drawer when the active commande changes — avoids stale
  // drawer state leaking into the next commande's lines.
  useEffect(() => {
    setPiecesDrawerLineId(null)
  }, [selectedId])

  const invalidateAll = useCallback(() => {
    // Réception creates a suivilot, reprise re-syncs its état — both surface on
    // Qualité › Suivi des lots, so refresh both screens (not just this one).
    invalidateLotQualityCaches(queryClient)
  }, [queryClient])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      dateCommande: hfsqlDateToInput(detail.date_commande),
      dateNotif: hfsqlDateToInput(detail.date_notif),
      commentaire: detail.commentaire?.trim() ?? '',
      journal: detail.journal?.trim() ?? '',
      IDadresseSt: detail.IDadresse_sous_traitant ?? 0,
      IDadresseLiv: detail.IDadresse_livraison ?? 0,
    }
    setEditDateCommande(snapshot.dateCommande)
    setEditDateNotif(snapshot.dateNotif)
    setEditCommentaire(snapshot.commentaire)
    setEditJournal(snapshot.journal)
    setEditIDAdresseSousTraitant(snapshot.IDadresseSt)
    setEditIDAdresseLivraison(snapshot.IDadresseLiv)
    originalDraftRef.current = snapshot
    editingIdRef.current = detail.IDcommande_sous_traitant
    setPiecesDrawerLineId(null)
    setIsEditing(true)
  }, [detail])

  // Clear all header-draft state when leaving edit mode. `editCommentaire` (and
  // the rest) are sticky page state — without this they survive across
  // commandes and can leak into the next save.
  const resetEditDraft = useCallback(() => {
    setEditDateCommande('')
    setEditDateNotif('')
    setEditCommentaire('')
    setEditJournal('')
    setEditIDAdresseSousTraitant(0)
    setEditIDAdresseLivraison(0)
    originalDraftRef.current = null
    editingIdRef.current = null
  }, [])

  const cancelEdit = useCallback(() => { setIsEditing(false); resetEditDraft() }, [resetEditDraft])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editDateCommande !== o.dateCommande) return true
    if (editDateNotif !== o.dateNotif) return true
    if (editCommentaire !== o.commentaire) return true
    if (editJournal !== o.journal) return true
    if (editIDAdresseSousTraitant !== o.IDadresseSt) return true
    if (editIDAdresseLivraison !== o.IDadresseLiv) return true
    if (linesDirty) return true
    return false
  }, [isEditing, editDateCommande, editDateNotif, editCommentaire, editJournal, editIDAdresseSousTraitant, editIDAdresseLivraison, linesDirty])

  const saveHeaderMut = useMutation({
    // Target the pinned edited id, not the live selectedId — guards against a
    // mid-edit selection drift writing this draft onto a different commande.
    mutationFn: () => apiFetch(`/commandes-sous-traitant/${editingIdRef.current ?? selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        date_commande: inputDateToHfsql(editDateCommande),
        date_notif: inputDateToHfsql(editDateNotif),
        commentaire: editCommentaire,
        journal: editJournal,
        IDadresse_sous_traitant: editIDAdresseSousTraitant || 0,
        IDadresse_livraison: editIDAdresseLivraison || 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false); resetEditDraft() },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/commandes-sous-traitant/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      // The list cache is now an `InfiniteData<CommandeListRow[]>`. Flatten
      // its pages to find the next-best row to auto-select once the current
      // one is gone.
      const cached = queryClient.getQueryData<InfiniteData<CommandeListRow[]>>(['commandes-sst', statusFilter])
      const flat = cached?.pages.flatMap((p) => p) ?? []
      const remaining = flat.filter((c) => c.IDcommande_sous_traitant !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['commandes-sst'] })
      setIsEditing(false)
      setDeleteCommandeConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDcommande_sous_traitant : null)
    },
  })

  // Auto-enter edit mode after create
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDcommande_sous_traitant === autoEditForId) {
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
    mutationFn: (newEtat: number) => apiFetch(`/commandes-sous-traitant/${selectedId}/etat`, {
      method: 'PUT',
      body: JSON.stringify({ est_soldee: newEtat }),
    }),
    onSuccess: invalidateAll,
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setSelectedId(id)
    })
  }, [guard])

  const handleStatusFilterChange = useCallback((s: StatusFilter) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setStatusFilter(s)
      setSelectedId(null)
      // Switching to "Terminées" deselects the urgency pills: an attente-
      // délai bucket is by definition open work, so the two would conflict.
      if (s === 'terminee') {
        setUrgencyLateOn(false)
        setUrgencySoonOn(false)
      }
    })
  }, [guard])

  // Clicking a pill while "Terminées" is the active toggle bumps the bar
  // back to "En cours" before applying the pill — the operator clearly
  // wants to look at open work.
  const handleToggleUrgencyLate = useCallback(() => {
    if (statusFilter === 'terminee') setStatusFilter('open')
    setUrgencyLateOn((v) => !v)
  }, [statusFilter])
  const handleToggleUrgencySoon = useCallback(() => {
    if (statusFilter === 'terminee') setStatusFilter('open')
    setUrgencySoonOn((v) => !v)
  }, [statusFilter])

  // Server-side search now does the heavy lifting (debounced 200 ms, hits
  // SQL via the catalog-cache in `sst-search-cache.ts`). No client-side
  // pre-filter — that used to flicker, filtering the previous response
  // against the current keystroke while the new fetch was in flight.
  const filtered = commandes ?? []

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
            attenteDelaiLate={urgencyCounts?.late ?? 0}
            attenteDelaiSoon={urgencyCounts?.soon ?? 0}
            urgencyLateOn={urgencyLateOn}
            urgencySoonOn={urgencySoonOn}
            onToggleUrgencyLate={handleToggleUrgencyLate}
            onToggleUrgencySoon={handleToggleUrgencySoon}
            onNew={() => setCreateOpen(true)}
            isEditing={isEditing}
            hasNextPage={!!hasNextPage}
            onLoadMore={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage() }}
            isFetchingNextPage={isFetchingNextPage}
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
                window.open(`${API_URL}/commandes-sous-traitant/${selectedId}/pdf`, '_blank')
              }
            }}
            onEmailClick={() => setEmailModalOpen(true)}
            onSoumettreClick={onSoumettreClick}
            soumettreEligibleCount={eligibleLots.length}
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
            piecesDrawerLineId={piecesDrawerLineId}
            onOpenPiecesDrawer={setPiecesDrawerLineId}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            commande={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editDateCommande={editDateCommande}
            onEditDateCommandeChange={setEditDateCommande}
            editDateNotif={editDateNotif}
            onEditDateNotifChange={setEditDateNotif}
            editCommentaire={editCommentaire}
            onEditCommentaireChange={setEditCommentaire}
            editJournal={editJournal}
            onEditJournalChange={setEditJournal}
            editIDAdresseSousTraitant={editIDAdresseSousTraitant}
            onEditIDAdresseSousTraitantChange={setEditIDAdresseSousTraitant}
            editIDAdresseLivraison={editIDAdresseLivraison}
            onEditIDAdresseLivraisonChange={setEditIDAdresseLivraison}
            onToggleEtat={() => toggleEtatMut.mutate(detail?.est_soldee === 1 ? 0 : 1)}
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
          queryClient.invalidateQueries({ queryKey: ['commandes-sst'] })
          // New commandes start at phase=non_envoye → the 'open' macro
          // filter already covers it, but make the switch explicit so a
          // user who had picked 'Terminées' before creating doesn't lose
          // sight of the freshly-created row.
          setStatusFilter('open')
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteCommandeConfirmOpen}
        title="Supprimer la commande"
        description="Cette action supprimera la commande, toutes ses lignes et libérera les rouleaux écru affectés. Elle est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteCommandeConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />

      {selectedId !== null && (
        <SendEmailDialog
          open={emailModalOpen}
          onClose={() => setEmailModalOpen(false)}
          contextLabel={detail?.sous_traitant_nom ?? undefined}
          queryKey={['commande-sst-email-defaults', selectedId]}
          loadDefaults={() => apiFetch(`/commandes-sous-traitant/${selectedId}/email-defaults`)}
          pdfUrl={`${API_URL}/commandes-sous-traitant/${selectedId}/pdf`}
          pdfAttachmentLabel={`commande-sous-traitant-${selectedId}.pdf`}
          onSend={async (p) => {
            await postEmail(`${API_URL}/commandes-sous-traitant/${selectedId}/email`, p, { includeAttachPdf: true })
            // Server-side, sending the bon de commande flips every
            // Non_Envoye line to Attente_Delai AND logs an envoi_email
            // row (IDtype_doc=13). Invalidate the queries the UI reads
            // those signals from so the phase pill, the left-list card,
            // and the historique tab all refresh without a manual reload.
            queryClient.invalidateQueries({ queryKey: ['commande-sst', selectedId] })
            queryClient.invalidateQueries({ queryKey: ['commandes-sst'] })
            queryClient.invalidateQueries({ queryKey: ['commande-sst-historique', selectedId] })
          }}
        />
      )}

      {/* Soumission Lot picker — shown when multiple lots are eligible. */}
      <SoumissionLotPicker
        open={soumissionPickerOpen}
        lots={eligibleLots}
        onClose={() => setSoumissionPickerOpen(false)}
        onSelect={(lot) => {
          setSelectedSoumissionLot(lot)
          setSoumissionPickerOpen(false)
          setSoumissionEmailOpen(true)
        }}
      />

      {/* Soumission Lot email modal — reuses SendEmailDialog with the
          soumission-specific endpoints. PDF + recipients regenerate
          server-side per lot when the user sends. */}
      {selectedId !== null && selectedSoumissionLot && (
        <SendEmailDialog
          open={soumissionEmailOpen}
          onClose={() => {
            setSoumissionEmailOpen(false)
            setSelectedSoumissionLot(null)
          }}
          contextLabel={`Lot ${selectedSoumissionLot.lot} · ${selectedSoumissionLot.client_nom}`}
          queryKey={['commande-sst-soumission-email-defaults', selectedId, selectedSoumissionLot.key]}
          loadDefaults={() => apiFetch(
            `/commandes-sous-traitant/${selectedId}/soumission/email-defaults?${buildSoumissionLotQuery(selectedSoumissionLot)}`,
          )}
          pdfUrl={`${API_URL}/commandes-sous-traitant/${selectedId}/soumission/pdf?${buildSoumissionLotQuery(selectedSoumissionLot)}`}
          pdfAttachmentLabel={`soumission-lot-${selectedSoumissionLot.lot}.pdf`}
          onSend={async (p) => {
            await postEmail(
              `${API_URL}/commandes-sous-traitant/${selectedId}/soumission/email`,
              p,
              {
                includeAttachPdf: true,
                extraBody: {
                  ref_fini: selectedSoumissionLot.IDref_fini,
                  coloris: selectedSoumissionLot.IDColoris,
                  lot: selectedSoumissionLot.lot,
                  commande_client: selectedSoumissionLot.IDcommande_client,
                },
              },
            )
            // Soumission send logs an envoi_email row (IDtype_doc=15) which the
            // phase computation reads to flip the commande to 'soumis', AND
            // sets the lot to "Attente Client" on Qualité › Suivi des lots.
            // Refresh both screens + the historique tab.
            invalidateLotQualityCaches(queryClient)
            queryClient.invalidateQueries({ queryKey: ['commande-sst-historique', selectedId] })
          }}
        />
      )}
    </>
  )
}

function buildSoumissionLotQuery(lot: EligibleLot): string {
  return new URLSearchParams({
    ref_fini: String(lot.IDref_fini),
    coloris: String(lot.IDColoris),
    lot: lot.lot,
    commande_client: String(lot.IDcommande_client),
  }).toString()
}

// ── Left Panel: List ───────────────────────────────────

function CommandeList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange,
  attenteDelaiLate, attenteDelaiSoon,
  urgencyLateOn, urgencySoonOn,
  onToggleUrgencyLate, onToggleUrgencySoon,
  onNew, isEditing,
  hasNextPage, onLoadMore, isFetchingNextPage,
}: {
  rows: CommandeListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (s: StatusFilter) => void
  /** Count of open `attente_delai` commandes whose bon de commande was
   *  sent 3+ days ago — shown as the red pill in the header. 0 hides it. */
  attenteDelaiLate: number
  /** Same but the 2-days-ago bucket — shown as the amber pill. */
  attenteDelaiSoon: number
  urgencyLateOn: boolean
  urgencySoonOn: boolean
  onToggleUrgencyLate: () => void
  onToggleUrgencySoon: () => void
  onNew: () => void
  isEditing: boolean
  /** True while the backend has more rows behind the current cursor. */
  hasNextPage: boolean
  /** Trigger the next page fetch. Caller debounces. */
  onLoadMore: () => void
  /** True while the next page is currently in-flight. */
  isFetchingNextPage: boolean
}) {
  // IntersectionObserver-driven infinite scroll. The sentinel sits at the
  // bottom of the list's scroll container; the moment it enters the
  // viewport we call `onLoadMore`. The observer's `root` is the scroll
  // container itself (not the page viewport) — otherwise the sentinel
  // never intersects because the surrounding scroll-area clips it.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || !hasNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore()
      },
      { root, rootMargin: '200px 0px 200px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, onLoadMore, rows.length])
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Rechercher (n°, sous-traitant, référence, coloris...)"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              autoComplete="off"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {/* Attente Délai urgency pills. Number-only, sit flush to the
              right of the search input, each pill an independent toggle.
              Hidden individually when their bucket is empty. */}
          {attenteDelaiLate > 0 && (
            <button
              type="button"
              onClick={onToggleUrgencyLate}
              aria-pressed={urgencyLateOn}
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                urgencyLateOn
                  ? 'bg-red-500 text-white border-red-500 shadow-sm'
                  : 'bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20'
              )}
            >
              {attenteDelaiLate}
            </button>
          )}
          {attenteDelaiSoon > 0 && (
            <button
              type="button"
              onClick={onToggleUrgencySoon}
              aria-pressed={urgencySoonOn}
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                urgencySoonOn
                  ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                  : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20'
              )}
            >
              {attenteDelaiSoon}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {([
            { key: 'open',     label: 'En cours' },
            { key: 'terminee', label: 'Terminées' },
            { key: 'all',      label: 'Toutes' },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => onStatusFilterChange(opt.key)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
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

      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">{error?.message || 'Erreur'}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Building2 className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune commande</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.IDcommande_sous_traitant
          // `attente_delai` cards measure urgency from the `date_notif`
          // relance date (amber the day before, red on the day and after).
          // All other open phases keep using the earliest-delivery deadline.
          const urgency = row.phase === 'attente_delai'
            ? attenteDelaiUrgency(row.date_notif, row.bon_envoye_at)
            : deliveryUrgency(row.earliest_delivery, row.est_soldee)
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
              key={row.IDcommande_sous_traitant}
              onClick={() => onSelect(row.IDcommande_sous_traitant)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected ? selectedRingClass : hoverClass,
                urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]'
              )}
            >
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm">N° {row.IDcommande_sous_traitant}</span>
                <PhasePill phase={row.phase} className="ml-auto" />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{row.sous_traitant_nom || '—'}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                {row.date_commande && <span>{formatHfsqlDate(row.date_commande)}</span>}
                {!!row.sous_traitant_type && (
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-medium',
                    sstTypeTagClasses(row.sous_traitant_type),
                  )}>
                    {row.sous_traitant_type}
                  </span>
                )}
                {row.total_eur > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 rounded bg-zinc-200/80 font-medium tabular-nums">
                    {fmtNum(row.total_eur)} €
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {/* Bottom sentinel — invisible div that triggers `onLoadMore` when
            scrolled into view. Rendered only when there are still pages to
            fetch. The spinner below it appears while the new page is on
            the wire so the user knows progress is happening. */}
        {hasNextPage && !isLoading && !isError && rows.length > 0 && (
          <>
            <div ref={sentinelRef} aria-hidden="true" className="h-1" />
            {isFetchingNextPage && (
              <div className="flex items-center justify-center py-3 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
          </>
        )}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {rows.length} commande{rows.length !== 1 ? 's' : ''}
          {hasNextPage && <span className="text-muted-foreground/70"> (faire défiler pour charger plus)</span>}
        </span>
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
  onSoumettreClick, soumettreEligibleCount,
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
  /** Opens the soumission flow — picker if multiple lots, email modal directly if 1. */
  onSoumettreClick: () => void
  /** Eligibility count from /lots-eligibles. Button is hidden when 0. */
  soumettreEligibleCount: number
}) {
  if (!commande && !isLoading) return null

  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Building2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                N° {commande?.IDcommande_sous_traitant}
                <span className="text-muted-foreground font-normal"> · {commande?.sous_traitant_nom || '—'}</span>
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {!!commande?.sous_traitant_type && (
                  // Same hue-per-type chip as the left-list cards (see
                  // sstTypeTagClasses). Use a span with the helper's classes
                  // rather than the secondary Badge so the colour is type-aware.
                  <span className={cn(
                    'px-2 py-0.5 rounded text-xs font-medium',
                    sstTypeTagClasses(commande.sous_traitant_type),
                  )}>
                    {commande.sous_traitant_type}
                  </span>
                )}
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
                {soumettreEligibleCount > 0 && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    title="Soumettre au client"
                    onClick={onSoumettreClick}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
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

// ── Soumission Lot picker ─────────────────────────────────
// Modelled on AdressePickerDialog (line ~3494). Renders two flavours of
// candidate:
//   - 'received' (lot known) → click sends straight to email modal
//   - 'manual'   (no fini yet) → expands an inline "Numéro de lot" input;
//                                user types the lot then clicks Continuer
function SoumissionLotPicker({
  open, lots, onClose, onSelect,
}: {
  open: boolean
  lots: EligibleLot[]
  onClose: () => void
  /** For manual entries the caller receives the candidate with `lot` set
   *  to the user-typed string — the downstream URL/params machinery is
   *  identical to the received path. */
  onSelect: (lot: EligibleLot) => void
}) {
  // Which manual entry is currently expanded for lot input, and the typed
  // value. Keyed by candidate.key.
  const [manualKey, setManualKey] = useState<string | null>(null)
  const [manualLot, setManualLot] = useState('')
  // Reset edit state whenever the dialog reopens.
  useEffect(() => {
    if (!open) { setManualKey(null); setManualLot('') }
  }, [open])

  const received = lots.filter((l) => l.kind === 'received')
  const manual = lots.filter((l) => l.kind === 'manual')

  const confirmManual = (lot: EligibleLot) => {
    const v = manualLot.trim()
    if (!v) return
    onSelect({ ...lot, lot: v })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg space-y-4" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-accent" />
            Choisir un lot à soumettre
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-3 px-1">
          {received.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">Lots reçus</div>
              {received.map((lot) => (
                <button
                  key={lot.key}
                  type="button"
                  onClick={() => onSelect(lot)}
                  className="w-full text-left p-3 rounded-md border border-zinc-200 hover:border-accent hover:bg-accent/5 transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-semibold text-primary truncate">
                      Lot {lot.lot}
                    </div>
                    <div className="text-xs text-muted-foreground flex-shrink-0">
                      {lot.client_nom}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {lot.ref_malterre}
                    {lot.coloris_reference ? ` · ${lot.coloris_reference}` : ''}
                  </div>
                  {lot.numero > 0 && (
                    <div className="text-xs mt-1">
                      <span className="font-medium text-foreground tabular-nums">Commande N° {lot.numero}</span>
                      {lot.date_commande ? <span className="text-muted-foreground"> · {formatHfsqlDate(lot.date_commande)}</span> : ''}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    {lot.nb_rolls} rouleau{lot.nb_rolls > 1 ? 'x' : ''} · {fmtNum(lot.total_metrage, 1)} Ml
                  </div>
                </button>
              ))}
            </div>
          )}

          {manual.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-1">
                Saisir un lot (aucun rouleau réceptionné)
              </div>
              {manual.map((lot) => {
                const expanded = manualKey === lot.key
                return (
                  <div
                    key={lot.key}
                    className={`p-3 rounded-md border transition-colors ${
                      expanded ? 'border-accent bg-accent/5' : 'border-zinc-200 hover:border-accent hover:bg-accent/5'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (expanded) { setManualKey(null); setManualLot('') }
                        else { setManualKey(lot.key); setManualLot('') }
                      }}
                      className="w-full text-left"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-sm font-semibold text-primary truncate">
                          {lot.client_nom}
                        </div>
                        <div className="text-xs text-muted-foreground flex-shrink-0">
                          {lot.ref_malterre}
                          {lot.coloris_reference ? ` · ${lot.coloris_reference}` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Réf client : {lot.client_designation || '—'}
                      </div>
                      {lot.numero > 0 && (
                        <div className="text-xs mt-1">
                          <span className="font-medium text-foreground tabular-nums">Commande N° {lot.numero}</span>
                          {lot.date_commande ? <span className="text-muted-foreground"> · {formatHfsqlDate(lot.date_commande)}</span> : ''}
                        </div>
                      )}
                    </button>
                    {!!expanded && (
                      <div className="mt-3 flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={manualLot}
                          onChange={(e) => setManualLot(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); confirmManual(lot) }
                            if (e.key === 'Escape') { e.preventDefault(); setManualKey(null); setManualLot('') }
                          }}
                          placeholder="Numéro de lot"
                          className="flex-1 h-9 px-3 rounded-md border border-zinc-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
                        />
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={!manualLot.trim()}
                          onClick={() => confirmManual(lot)}
                        >
                          Continuer
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {lots.length === 0 && (
            <p className="text-sm text-muted-foreground italic px-2 py-4 text-center">
              Aucun lot éligible
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}


// ── Center: Detail Main ────────────────────────────────

function DetailMain({
  commande, isLoading, hasSelection, isEditing, onMutationSuccess, onLinesDirtyChange, piecesDrawerLineId, onOpenPiecesDrawer,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  piecesDrawerLineId: number | null
  onOpenPiecesDrawer: (lineId: number | null) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Building2 className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Aucune commande sélectionnée</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!commande) return null

  // Nominal projection (qty × prix) and actual (attached kg × prix). The
  // line cards show both; the footer surfaces the actual € total because
  // that's what will actually be billed.
  const totalQte = commande.lignes.reduce((s, l) => s + (l.quantite != null ? Number(l.quantite) : 0), 0)
  const totalKgEcru = commande.lignes.reduce((s, l) => s + (Number(l.total_kg_ecru_lie) || 0), 0)
  const totalMetrageFini = commande.lignes.reduce((s, l) => s + (Number(l.total_metrage_fini_recu) || 0), 0)
  // Per-line € total branches by type:
  //   - tricoteur (type=1): line.quantite is already in kg of écru ordered;
  //     total = quantite × prix (€/kg). Knowable up front.
  //   - ennoblisseur (type=2) / écru (type=0): total = attached_kg × prix
  //     because quantite is in Ml, not kg — multiply by Ml × €/kg is unitless
  //     garbage. The bill comes from the real shipped écru weight.
  const totalEurReal = commande.lignes.reduce((s, l) => {
    const prix = Number(l.prix) || 0
    if (l.type === 1) return s + ((Number(l.quantite) || 0) * prix)
    return s + ((Number(l.total_kg_ecru_lie) || 0) * prix)
  }, 0)

  return (
    <LignesSection
      commande={commande}
      isEditing={isEditing}
      totalQte={totalQte}
      totalKgEcru={totalKgEcru}
      totalMetrageFini={totalMetrageFini}
      totalEurReal={totalEurReal}
      onMutationSuccess={onMutationSuccess}
      onLinesDirtyChange={onLinesDirtyChange}
      piecesDrawerLineId={piecesDrawerLineId}
      onOpenPiecesDrawer={onOpenPiecesDrawer}
    />
  )
}

// ── Center: Lignes Section ─────────────────────────────

function LignesSection({
  commande, isEditing, totalQte, totalKgEcru, totalMetrageFini, totalEurReal,
  onMutationSuccess, onLinesDirtyChange, piecesDrawerLineId, onOpenPiecesDrawer,
}: {
  commande: CommandeDetail
  isEditing: boolean
  totalQte: number
  totalKgEcru: number
  totalMetrageFini: number
  totalEurReal: number
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  piecesDrawerLineId: number | null
  onOpenPiecesDrawer: (lineId: number | null) => void
}) {
  const [editingLineId, setEditingLineId] = useState<number | null>(null)
  const [showLineForm, setShowLineForm] = useState(false)
  const [deleteLineConfirmId, setDeleteLineConfirmId] = useState<number | null>(null)
  // For ennoblisseur lines, IDreference holds an IDref_fini (the desired
  // dyed/finished reference). The drawer maps fini → écru via ref_fini.IDref_ecru
  // when offering compatible greige rolls.
  const [lineForm, setLineForm] = useState({
    IDreference: 0,
    IDColoris: 0,
    quantite: '',
    prix: '',
    date_livraison: '',
  })

  // Per-lot breakdown of received fini rolls merged across all lines —
  // feeds the "Ml reçus" tooltip in the totals footer.
  const finiLotsMerged = useMemo(() => {
    const map = new Map<string, { lot: string; nb: number; metrage: number }>()
    for (const l of commande.lignes) {
      for (const fl of l.fini_lots ?? []) {
        const key = fl.lot.trim()
        const acc = map.get(key) ?? { lot: key, nb: 0, metrage: 0 }
        acc.nb += fl.nb
        acc.metrage += fl.metrage
        map.set(key, acc)
      }
    }
    return Array.from(map.values()).sort((a, b) => a.lot.localeCompare(b.lot))
  }, [commande.lignes])

  const linesLocked = commande.est_soldee === 1
  const isEnnoblisseur = isEnnoblisseurType(commande.sous_traitant_type)
  const isTricoteur = (commande.sous_traitant_type ?? '').trim().toLowerCase() === TYPE_TRICOTEUR.toLowerCase()
  // Phase 2: both ennoblisseur and tricoteur can edit lines from ETM.
  // Other sst types (confectionneur, autre) still defer to legacy.
  const linesEditable = isEnnoblisseur || isTricoteur

  useEffect(() => {
    if (!isEditing || linesLocked) {
      setEditingLineId(null)
      setShowLineForm(false)
    }
  }, [isEditing, linesLocked])

  useEffect(() => {
    onLinesDirtyChange(showLineForm || editingLineId !== null)
  }, [showLineForm, editingLineId, onLinesDirtyChange])

  // Line picker source — ref_fini for ennoblisseur, ref_ecru for tricoteur.
  // We keep two parallel React-Query hooks; only one fetches per commande.
  const { data: refFiniLookup } = useQuery<RefFiniLookup[]>({
    queryKey: ['commande-sst-refs-fini'],
    queryFn: () => apiFetch('/commandes-sous-traitant/lookups/refs-fini'),
    enabled: isEditing && isEnnoblisseur,
  })
  const { data: refEcruLookup } = useQuery<RefEcruLookup[]>({
    queryKey: ['commande-sst-refs-ecru-list'],
    queryFn: () => apiFetch('/commandes-sous-traitant/lookups/refs-ecru-list'),
    enabled: isEditing && isTricoteur,
  })

  const createLineMut = useMutation({
    mutationFn: () => apiFetch(`/commandes-sous-traitant/${commande.IDcommande_sous_traitant}/lignes`, {
      method: 'POST',
      body: JSON.stringify({
        // Tricoteur lines store an IDref_ecru + IDcolori_ecru; ennoblisseur
        // lines store an IDref_fini + IDref_fini_colori. The backend gates
        // type/unite/prix-default on the parent sst's IDtype_sst, but we
        // pass them explicitly here for symmetry / future-proofing.
        type: isTricoteur ? 1 : 2,
        IDreference: lineForm.IDreference,
        IDColoris: lineForm.IDColoris,
        quantite: Number(lineForm.quantite) || 0,
        prix: Number(lineForm.prix) || 0,
        unite: isTricoteur ? 1 : 0,  // 1=kg (tricoteur), 0=Ml (ennoblisseur)
        date_livraison: inputDateToHfsql(lineForm.date_livraison),
      }),
    }),
    onSuccess: () => { onMutationSuccess(); resetLineForm() },
  })

  const updateLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/commandes-sous-traitant/lignes/${lineId}`, {
      method: 'PUT',
      body: JSON.stringify({
        IDreference: lineForm.IDreference,
        IDColoris: lineForm.IDColoris,
        quantite: Number(lineForm.quantite) || 0,
        prix: Number(lineForm.prix) || 0,
        date_livraison: inputDateToHfsql(lineForm.date_livraison),
      }),
    }),
    onSuccess: () => { onMutationSuccess(); setEditingLineId(null); resetLineForm() },
  })

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/commandes-sous-traitant/lignes/${lineId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const resetLineForm = () => {
    setLineForm({ IDreference: 0, IDColoris: 0, quantite: '', prix: '', date_livraison: '' })
    setShowLineForm(false)
  }

  // HFSQL stores quantites as float32 — round-trip via String() leaks digits
  // like "36,20000076293945". Format to a clean decimal for the input.
  const fmtNumberInput = (v: number | null | undefined): string => {
    if (v == null) return ''
    const n = Number(v)
    if (Number.isNaN(n)) return ''
    // Up to 2 decimals, trim trailing zeros and a dangling dot.
    return n.toFixed(2).replace(/\.?0+$/, '')
  }

  const startEditLine = (l: LigneCommande) => {
    setShowLineForm(false)
    setEditingLineId(l.IDligne_commande_sous_traitant)
    setLineForm({
      IDreference: l.IDreference ?? 0,
      IDColoris: l.IDColoris ?? 0,
      quantite: fmtNumberInput(l.quantite),
      prix: fmtNumberInput(l.prix),
      date_livraison: hfsqlDateToInput(l.date_livraison),
    })
  }

  const startAddLine = () => {
    setEditingLineId(null)
    setLineForm({ IDreference: 0, IDColoris: 0, quantite: '', prix: '', date_livraison: '' })
    setShowLineForm(true)
  }

  // Line drawer is mounted when the user clicks a supported line:
  //   • type=2 (ennoblisseur / fini) → PiecesDrawer (linkable écru +
  //     fini reception, full Phase 1 flow).
  //   • type=1 (tricoteur / fil) → TricoteurDrawer (read-only Phase 2
  //     pass: Réception + Stock fil tabs).
  // Other types are not yet wired up — clicking those lines is a no-op.
  const drawerOpen = piecesDrawerLineId !== null && !isEditing
  const drawerLigne = drawerOpen
    ? commande.lignes.find((l) => l.IDligne_commande_sous_traitant === piecesDrawerLineId) ?? null
    : null
  const drawerKind: 'ennoblisseur' | 'tricoteur' | null = (() => {
    if (!drawerLigne) return null
    if (drawerLigne.type === 2) return 'ennoblisseur'
    if (drawerLigne.type === 1) return 'tricoteur'
    return null
  })()
  const drawerMounted = drawerOpen && drawerLigne !== null && drawerKind !== null

  // Order quantity unit for the totals footer — kg when every line is
  // tricoteur (type=1, output écru weight), Ml when every line is
  // ennoblisseur (type=2, output fabric meterage). Mixed commandes
  // shouldn't happen today; fall back to Ml (the historical default).
  const commandeTotalUnit: 'kg' | 'Ml' =
    commande.lignes.length > 0 && commande.lignes.every((l) => l.type === 1) ? 'kg' : 'Ml'

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div
          className={cn(
            'overflow-auto space-y-2 p-1 scrollbar-transparent',
            drawerMounted ? 'flex-shrink-0 max-h-[40%]' : 'flex-1 min-h-0'
          )}
        >
          {commande.lignes.length === 0 && !showLineForm ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FiniRollIcon className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune ligne</p>
              {isEditing && !linesLocked && linesEditable && (
                <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
                </Button>
              )}
              {isEditing && !linesLocked && !linesEditable && (
                <p className="text-[11px] text-muted-foreground italic mt-3 max-w-xs text-center">
                  L'ajout de ligne n'est disponible pour ce type de sous-traitant qu'à partir de la phase 2.
                </p>
              )}
            </div>
          ) : (
            commande.lignes.map((l) => {
              if (isEditing && editingLineId === l.IDligne_commande_sous_traitant) {
                return (
                  <InlineForm
                    key={l.IDligne_commande_sous_traitant}
                    title="Modifier la ligne"
                    onSave={() => updateLineMut.mutate(l.IDligne_commande_sous_traitant)}
                    onCancel={() => { setEditingLineId(null); resetLineForm() }}
                    isSaving={updateLineMut.isPending}
                  >
                    <LineFormFields
                      form={lineForm}
                      setForm={setLineForm}
                      kind={isTricoteur ? 'ecru' : 'fini'}
                      refsFini={refFiniLookup ?? []}
                      refsEcru={refEcruLookup ?? []}
                      editable={linesEditable}
                      autoPricing={isTricoteur ? false : commande.auto_pricing_enabled}
                    />
                  </InlineForm>
                )
              }
              return (
                <LineCard
                  key={l.IDligne_commande_sous_traitant}
                  line={l}
                  isEditing={isEditing}
                  linesLocked={linesLocked}
                  isEnnoblisseur={isEnnoblisseur}
                  linesEditable={linesEditable}
                  isDrawerOpen={piecesDrawerLineId === l.IDligne_commande_sous_traitant}
                  bonEnvoyeAt={commande.bon_envoye_at}
                  dateNotif={commande.date_notif}
                  onEdit={() => startEditLine(l)}
                  onDelete={() => setDeleteLineConfirmId(l.IDligne_commande_sous_traitant)}
                  onOpenDrawer={onOpenPiecesDrawer}
                />
              )
            })
          )}

          {isEditing && !linesLocked && linesEditable && showLineForm && (
            <InlineForm
              title="Nouvelle ligne"
              onSave={() => createLineMut.mutate()}
              onCancel={resetLineForm}
              isSaving={createLineMut.isPending}
            >
              <LineFormFields
                form={lineForm}
                setForm={setLineForm}
                kind={isTricoteur ? 'ecru' : 'fini'}
                refsFini={refFiniLookup ?? []}
                refsEcru={refEcruLookup ?? []}
                editable={true}
                autoPricing={isTricoteur ? false : commande.auto_pricing_enabled}
              />
            </InlineForm>
          )}

          {isEditing && !linesLocked && linesEditable && commande.lignes.length > 0 && !showLineForm && editingLineId === null && (
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

        {drawerMounted && drawerLigne && (
          <div className="flex-1 min-h-0 flex flex-col mt-3 rounded-lg border border-border/60 overflow-hidden bg-zinc-50/80 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
            {drawerKind === 'ennoblisseur' && (
              <PiecesDrawer
                commandeId={commande.IDcommande_sous_traitant}
                sousTraitantNom={commande.sous_traitant_nom}
                ligne={drawerLigne}
                commandeSoldee={commande.est_soldee === 1}
                onClose={() => onOpenPiecesDrawer(null)}
                onSuccess={onMutationSuccess}
              />
            )}
            {drawerKind === 'tricoteur' && (
              <TricoteurDrawer
                commandeId={commande.IDcommande_sous_traitant}
                ligne={drawerLigne}
                commandeSoldee={commande.est_soldee === 1}
                onClose={() => onOpenPiecesDrawer(null)}
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
              <span className="text-muted-foreground text-xs">Prévu {fmtNum(totalQte, 1)} {commandeTotalUnit}</span>
              {totalKgEcru > 0 && (
                <span className="text-muted-foreground text-xs">
                  · {fmtNum(totalKgEcru, 1)} kg affectés
                </span>
              )}
              {totalMetrageFini > 0 && (
                finiLotsMerged.length > 0 ? (
                  <Tooltip
                    side="top"
                    content={
                      <div className="space-y-1.5 py-0.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                          Métrage reçu par lot
                        </p>
                        <ul className="space-y-1">
                          {finiLotsMerged.map((fl) => (
                            <li key={fl.lot || '__sans_lot'} className="flex items-baseline justify-between gap-4 whitespace-nowrap">
                              <span className="font-medium">{fl.lot ? `Lot ${fl.lot}` : 'Sans lot'}</span>
                              <span className="text-muted-foreground tabular-nums">
                                {fl.nb} rouleau{fl.nb > 1 ? 'x' : ''} · {fmtNum(fl.metrage, 1)} Ml
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    }
                  >
                    <span className="text-green-700 text-xs inline-flex items-center gap-1 cursor-pointer">
                      · {fmtNum(totalMetrageFini, 1)} Ml reçus
                      <FiniRollIcon className="h-3.5 w-3.5" />
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-green-700 text-xs">
                    · {fmtNum(totalMetrageFini, 1)} Ml reçus
                  </span>
                )
              )}
              <span className="text-accent text-base">{fmtNum(totalEurReal, 2)} €</span>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteLineConfirmId !== null}
        title="Supprimer la ligne"
        description="Cette ligne sera supprimée et les rouleaux écru affectés seront libérés."
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
  line, isEditing, linesLocked, isEnnoblisseur, linesEditable, isDrawerOpen, bonEnvoyeAt, dateNotif, onEdit, onDelete, onOpenDrawer,
}: {
  line: LigneCommande
  isEditing: boolean
  linesLocked: boolean
  isEnnoblisseur: boolean
  /** Commande-level bon-de-commande send date ("YYYY-MM-DD" or null),
   *  used to show "Attente depuis X jours" on an Attente_Delai line. */
  bonEnvoyeAt: string | null
  /** Commande-level relance date (`date_notif`, HFSQL YYYYMMDD or null),
   *  drives the Attente_Delai urgency colour. */
  dateNotif: string | null
  /** True when the parent commande's sst supports inline line editing in
   *  ETM (ennoblisseur OR tricoteur). Drives the per-card edit/delete
   *  affordances regardless of which exact type. */
  linesEditable: boolean
  isDrawerOpen: boolean
  onEdit: () => void
  onDelete: () => void
  onOpenDrawer: (lineId: number | null) => void
}) {
  const { border, iconBg, iconColor } = lineEtatColors(line.sstatut)
  const prix = Number(line.prix) || 0
  const qty = Number(line.quantite) || 0
  const totalKgEcru = Number(line.total_kg_ecru_lie) || 0
  const totalMetrageFini = Number(line.total_metrage_fini_recu) || 0
  // Actual € total. Branches by line type:
  //   - tricoteur (type=1): quantite IS the ordered kg of écru, so
  //     total = qty × prix is the correct line € from the start.
  //   - ennoblisseur (type=2) / écru (type=0): quantite is in Ml, can't
  //     be multiplied directly with €/kg; total = attached_écru_kg × prix.
  //     Falls back to 0 (and the line € row is hidden) until at least one
  //     roll is linked.
  const totalEur = line.type === 1 ? qty * prix : totalKgEcru * prix
  // Ml potentiel = kg écru affecté × rendement (Ml/kg from ref_fini).
  // A pre-réception estimate of how much fini the order should yield, used
  // to flag under/over-orders before the worker even starts dyeing.
  const rendement = Number(line.ref_rendement) || 0
  const mlPotentiel = totalKgEcru > 0 && rendement > 0 ? totalKgEcru * rendement : 0
  // Tolerance bands vs the ordered Ml. Green is "ideal yield" (between qty
  // and +5%), amber is "within tolerance" (qty-5% to qty+10% but outside the
  // green sweet spot), red is everything else. null = undecidable (no qty
  // or no rendement).
  //
  // Comparison is done on values rounded to 1 decimal (the display
  // precision) so the colour always matches what the user reads on the
  // card. Without this, e.g. potentiel=38.38 vs qty=38.40 — both shown as
  // "38,4 Ml" — falls into the amber band by 0.02 Ml of float noise, even
  // though the user reads two identical numbers and expects green.
  const potentielStatus: 'green' | 'amber' | 'red' | null = (() => {
    if (qty <= 0 || mlPotentiel <= 0) return null
    const pR = Math.round(mlPotentiel * 10) / 10
    const qR = Math.round(qty * 10) / 10
    if (qR <= 0) return null
    if (pR >= qR && pR <= qR * 1.05) return 'green'
    if (pR > qR * 0.95 && pR < qR * 1.10) return 'amber'
    return 'red'
  })()
  // Drawer is mounted for both ennoblisseur (type=2, full flow) and
  // tricoteur (type=1, read-only Réception + Stock fil tabs). Other line
  // types aren't wired up — keep them non-clickable.
  const drawerAvailable = line.type === 2 || line.type === 1
  const clickable = !isEditing && drawerAvailable
  // Order quantity unit is type-dependent: tricoteur lines are ordered in
  // kg of écru to produce; ennoblisseur (and legacy écru) lines are in Ml
  // of finished fabric. See [[project-sst-line-polymorphic]].
  const qtyUnit = line.type === 1 ? 'kg' : 'Ml'

  // "Délai initial" indicator: HFSQL stores YYYYMMDD; show only when rescheduled.
  const dateDelaiRaw = line.date_delai && /^\d{8}$/.test(line.date_delai) ? line.date_delai : ''
  const dateLivRaw = line.date_livraison && /^\d{8}$/.test(line.date_livraison) ? line.date_livraison : ''
  const showDelaiInitial = !!dateDelaiRaw && !!dateLivRaw && dateDelaiRaw !== dateLivRaw
  // Attente délai: bon de commande sent, no délai confirmed yet. The line
  // shows how long we've been waiting instead of a Livraison date.
  const isAttenteDelai = (line.sstatut ?? '').trim() === 'Attente_Delai'
  const attenteDays = isAttenteDelai ? attenteDelaiDays(bonEnvoyeAt) : null

  return (
    <div
      className={cn(
        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
        border,
        clickable && 'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
        isDrawerOpen && 'ring-1 ring-accent bg-accent/[0.06] border-accent/50'
      )}
      onClick={clickable ? () => onOpenDrawer(isDrawerOpen ? null : line.IDligne_commande_sous_traitant) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn('h-9 w-9 rounded-md flex items-center justify-center flex-shrink-0', iconBg)}>
            <FiniRollIcon className={cn('h-6 w-6', iconColor)} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {line.ref_label || '—'}
              {line.colori_reference ? <span className="text-muted-foreground"> / {line.colori_reference}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Per-line "En cours / Terminée" pill and toggle dropped — line
              state now derives from the per-roll EtatFiniBadge surfaced
              inside the pieces drawer. The commande header pill at the
              top of the sidebar carries the overall phase. */}
          {isEditing && !linesLocked && (
            <div className="flex gap-0.5">
              {linesEditable && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onEdit() }}>
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete() }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {/* Production metrics: Quantité commandée + Prix unitaire are two
          independent inputs (the employee enters them separately at
          line-creation), so they get their own rows. Then Affecté (kg +
          potentiel Ml + €) and Reçu (actual Ml) appear as work progresses.
          Each row is conditional on its values existing. */}
      {/* Production metrics grid. Each row is intentionally one line tall
          (label + value + right-aligned context) so vertical rhythm is
          uniform — past versions stacked Livraison + Délai initial in the
          right column of the Quantité row, which inflated that row to
          ~32px while the others stayed ~20px and made the gap to "Prix
          unit." feel off. The Délai initial reminder now sits inline next
          to Livraison as a small italic parenthetical.

          The line's € total (kg × prix) lives in its own footer row at
          the bottom with a thin top divider — it's a SUMMARY of all the
          metrics above, not a piece of the Affecté row. */}
      <div className="mt-1.5 ml-12 space-y-1.5 text-sm tabular-nums">
        {/* Quantité commandée — nominal Ml. The right side carries the
            Livraison date; if a rescheduled date exists, the original
            "(initial: ...)" date appears inline so this row stays a
            single line. */}
        {(qty > 0 || dateLivRaw || isAttenteDelai) && (
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground/80 w-24 flex-shrink-0">Quantité</span>
            <span className="text-foreground">
              {qty > 0 ? `${fmtNum(qty, 1)} ${qtyUnit}` : '—'}
            </span>
            {dateLivRaw ? (() => {
              const lineUrgency = deliveryUrgency(dateLivRaw, isLineDone(line.sstatut) ? 1 : 0)
              // When the délai is past, surface how overdue it is on a
              // second line right under the Livraison date.
              const overdue = lineUrgency === 'late' ? deliveryOverdueDays(dateLivRaw) : 0
              return (
                <span
                  className={cn(
                    'ml-auto flex flex-col items-end leading-tight',
                    lineUrgency === 'late' ? 'text-red-600'
                      : lineUrgency === 'soon' ? 'text-amber-600'
                      : 'text-foreground'
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="font-medium">Livraison {formatHfsqlDate(dateLivRaw)}</span>
                    {showDelaiInitial && (
                      <span className="text-xs italic text-muted-foreground">
                        (initial: {formatHfsqlDate(dateDelaiRaw)})
                      </span>
                    )}
                  </span>
                  {lineUrgency === 'late' && (
                    <span className="text-xs font-medium">
                      {overdue >= 1
                        ? `Expiré depuis ${overdue} jour${overdue > 1 ? 's' : ''}`
                        : "Échéance aujourd'hui"}
                    </span>
                  )}
                </span>
              )
            })() : isAttenteDelai ? (() => {
              // Bon de commande sent, no délai confirmed yet — show how long
              // we've been waiting. Colour mirrors the card urgency frame.
              const urgency = attenteDelaiUrgency(dateNotif, bonEnvoyeAt)
              const label = attenteDays == null
                ? 'En attente du délai'
                : attenteDays === 0
                  ? 'En attente du délai'
                  : `Attente depuis ${attenteDays} jour${attenteDays > 1 ? 's' : ''}`
              return (
                <span
                  className={cn(
                    'ml-auto flex items-center gap-1 font-medium',
                    urgency === 'late' ? 'text-red-600'
                      : urgency === 'soon' ? 'text-amber-600'
                      : 'text-muted-foreground'
                  )}
                >
                  <Hourglass className="h-3.5 w-3.5" />
                  {label}
                </span>
              )
            })() : null}
          </div>
        )}
        {/* Prix unitaire — independent value, €/Kg of finished fabric. */}
        {prix > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground/80 w-24 flex-shrink-0">Prix unit.</span>
            <span className="text-foreground">{fmtNum(prix, 2)} €/Kg</span>
            <PrixBreakdownInfo
              commandeId={line.IDcommande_sous_traitant}
              ligneId={line.IDligne_commande_sous_traitant}
            />
          </div>
        )}
        {/* Affecté — once écru is linked. Total kg + derived potentiel
            Ml (green/amber/red vs ordered Ml). The € total is no longer
            on this row — it has its own footer line below. */}
        {totalKgEcru > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground/80 w-24 flex-shrink-0">Affecté</span>
            <span className="text-foreground">{fmtNum(totalKgEcru, 1)} kg</span>
            {mlPotentiel > 0 && (
              <span
                className={cn(
                  'font-medium',
                  potentielStatus === 'green' && 'text-green-700',
                  potentielStatus === 'amber' && 'text-amber-600',
                  potentielStatus === 'red' && 'text-red-600',
                  potentielStatus === null && 'text-muted-foreground',
                )}
                title={qty > 0 ? `Commandé : ${fmtNum(qty, 1)} Ml` : undefined}
              >
                ~ {fmtNum(mlPotentiel, 1)} Ml
              </span>
            )}
          </div>
        )}
        {/* Reçu — once fini rolls have come back. The optional tolerance
            badge compares the received metrage to the ordered Ml: green
            inside ±5 %, red outside. Hidden when qty is 0 (can't compute
            a percentage against a zero baseline). */}
        {totalMetrageFini > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground/80 w-24 flex-shrink-0">Reçu</span>
            <span className="font-medium text-green-700">{fmtNum(totalMetrageFini, 1)} Ml</span>
            {qty > 0 && (() => {
              const diffPct = (totalMetrageFini - qty) / qty * 100
              const withinTolerance = Math.abs(diffPct) <= 5
              const sign = diffPct >= 0 ? '+' : '−'
              return (
                <span
                  className={cn(
                    'text-xs font-medium',
                    withinTolerance ? 'text-green-700' : 'text-red-600',
                  )}
                  title={`Commandé : ${fmtNum(qty, 1)} Ml`}
                >
                  ({sign}{fmtNum(Math.abs(diffPct), 1)} %)
                </span>
              )
            })()}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Prix unit. tooltip — breakdown of the auto-calc ────

interface PrixBreakdownData {
  enabled: true
  sst_nom: string
  teinture_nom: string | null
  traitement_names: Record<string, string>
  breakdown: {
    IDsous_traitant: number
    xPoids: number
    rendement: number
    avec_teinture: number
    IDteinture: number
    matel_multiplier: number
    base:
      | { kind: 'combination'; IDtranche: number; covered: number[]; raw_prix: number; applied_prix: number }
      | { kind: 'dye-only'; IDtranche: number; IDteinture: number; raw_prix: number; applied_prix: number }
      | null
    treatments: Array<{
      IDtraitement: number
      IDtranche: number
      raw_prix: number
      applied_prix: number
      matel_applied: boolean
    }>
    unpriced_treatments: number[]
    total: number
  }
}
type PrixBreakdownResponse = PrixBreakdownData | { enabled: false; reason: string }

function PrixBreakdownInfo({ commandeId, ligneId }: { commandeId: number; ligneId: number }) {
  const [hovering, setHovering] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Position the portal popover above the icon — fixed coordinates from
  // the trigger's bounding rect. We compute on hover-in (not on every
  // render) so it stays anchored even if a parent container scrolls.
  useEffect(() => {
    if (!hovering) { setPos(null); return }
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Open above the icon, horizontally aligned to its left edge so the
    // 280px popover doesn't overflow the right side of narrow cards.
    setPos({ top: r.top - 8, left: r.left })
  }, [hovering])

  const { data, isLoading } = useQuery<PrixBreakdownResponse>({
    queryKey: ['commande-sst-prix-breakdown', commandeId, ligneId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/lignes/${ligneId}/prix-breakdown`),
    enabled: hovering,
    staleTime: 30_000,
  })

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground/60 hover:text-accent transition-colors cursor-help"
        aria-label="Voir le détail du calcul"
      >
        <Info className="h-3 w-3" />
      </button>
      {hovering && pos && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
          className="z-50 w-[300px] rounded-md border bg-popover shadow-lg p-3 text-[11px] text-popover-foreground animate-in fade-in-0 zoom-in-95 pointer-events-none"
          role="tooltip"
        >
          <PrixBreakdownContent data={data} isLoading={isLoading} />
        </div>,
        document.body,
      )}
    </>
  )
}

function PrixBreakdownContent({ data, isLoading }: { data: PrixBreakdownResponse | undefined; isLoading: boolean }) {
  if (isLoading || !data) {
    return <p className="text-muted-foreground">Chargement…</p>
  }
  if (!data.enabled) {
    const reasons: Record<string, string> = {
      'not-ennoblisseur': 'Ligne non-ennoblisseur (saisie manuelle).',
      'no-tariff-data': 'Aucun tarif catalogue pour ce sous-traitant — prix saisi manuellement.',
      'no-weight': 'Aucun rouleau écru affecté.',
    }
    return <p className="text-muted-foreground italic">{reasons[data.reason] ?? 'Calcul indisponible.'}</p>
  }
  const { sst_nom, teinture_nom, traitement_names, breakdown: bd } = data
  const showMatelLine = bd.matel_multiplier !== 1
  return (
    <div className="space-y-2 tabular-nums">
      {/* Header: sst + weight + (matel multiplier when applicable) */}
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-border/60">
        <span className="font-semibold text-foreground">{sst_nom}</span>
        <span className="text-muted-foreground">{fmtNum(bd.xPoids, 1)} kg</span>
      </div>
      {showMatelLine && (
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Multiplicateur Matel</span>
          <span>rendement {fmtNum(bd.rendement, 2)} → ×{fmtNum(bd.matel_multiplier, 2)}</span>
        </div>
      )}
      {/* Base price */}
      {!!bd.base && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/80">Base</p>
          {bd.base.kind === 'dye-only' && (
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-foreground">{teinture_nom ?? `Teinture #${bd.base.IDteinture}`}</span>
              <span className="text-foreground font-medium">
                {bd.base.raw_prix === bd.base.applied_prix
                  ? `${fmtNum(bd.base.raw_prix, 2)} €`
                  : `${fmtNum(bd.base.raw_prix, 2)} × ${fmtNum(bd.matel_multiplier, 2)} = ${fmtNum(bd.base.applied_prix, 2)} €`}
              </span>
            </div>
          )}
          {bd.base.kind === 'combination' && (
            <div className="flex items-start justify-between mt-0.5 gap-2">
              <span className="text-foreground">
                Combinaison ({bd.base.covered.map((id) => traitement_names[id] || `#${id}`).join(', ')})
              </span>
              <span className="text-foreground font-medium flex-shrink-0">{fmtNum(bd.base.applied_prix, 2)} €</span>
            </div>
          )}
        </div>
      )}
      {/* Remaining treatments */}
      {bd.treatments.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/80">Traitements</p>
          <div className="space-y-0.5 mt-0.5">
            {bd.treatments.map((t) => (
              <div key={t.IDtraitement} className="flex items-center justify-between">
                <span className="text-foreground">
                  {traitement_names[t.IDtraitement] || `#${t.IDtraitement}`}
                  {t.matel_applied && (
                    <span className="ml-1 text-[9px] uppercase tracking-wide text-accent">×Matel</span>
                  )}
                </span>
                <span className="text-foreground font-medium">
                  {t.matel_applied
                    ? `${fmtNum(t.raw_prix, 2)} × ${fmtNum(bd.matel_multiplier, 2)} = ${fmtNum(t.applied_prix, 2)} €`
                    : `${fmtNum(t.applied_prix, 2)} €`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Unpriced — shouldn't usually happen but worth surfacing for catalog gaps */}
      {bd.unpriced_treatments.length > 0 && (
        <p className="text-[10px] text-amber-700 italic">
          Tarif manquant pour : {bd.unpriced_treatments.map((id) => traitement_names[id] || `#${id}`).join(', ')}
        </p>
      )}
      {/* Total */}
      <div className="flex items-center justify-between pt-1.5 border-t border-border/60">
        <span className="font-semibold text-foreground">Total</span>
        <span className="font-semibold text-foreground">{fmtNum(bd.total, 2)} €/Kg</span>
      </div>
    </div>
  )
}

// ── Pieces drawer (ennoblisseur-only) ──────────────────

function PiecesDrawer({
  commandeId, sousTraitantNom, ligne, commandeSoldee, onClose, onSuccess,
}: {
  commandeId: number
  /** Used in the LinkEcruDialog subtitle so the operator sees which sst's
   *  magasin the listed rolls belong to ("disponibles chez MATEL"). */
  sousTraitantNom: string | null | undefined
  ligne: LigneCommande
  /** True when the parent commande is `est_soldee = 1` (terminée). In
   *  that state the drawer is read-only: we hide the "+ Affecter" and
   *  "+ Réceptionner" trigger buttons so the user can't mutate a closed
   *  commande's pieces. (The detail-header status footer is the only
   *  legitimate path back to en-cours.) */
  commandeSoldee: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const queryKey = ['commande-sst-pieces', commandeId, ligne.IDligne_commande_sous_traitant] as const

  const { data, isLoading, isError } = useQuery<PiecesPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces`),
  })

  // Patch the commande detail cache so the LineCard re-renders with the
  // freshly-recalculated prix without waiting for a refetch. The parent's
  // `onSuccess()` callback still fires after, which invalidates the detail
  // query — so if the patch ever drifts from server truth, the next
  // refetch corrects it.
  const patchLinePrix = (newPrix: number) => {
    queryClient.setQueryData<CommandeDetail | undefined>(['commande-sst', commandeId], (old) => {
      if (!old) return old
      return {
        ...old,
        lignes: old.lignes.map((l) =>
          l.IDligne_commande_sous_traitant === ligne.IDligne_commande_sous_traitant
            ? { ...l, prix: newPrix }
            : l,
        ),
      }
    })
  }

  const linkEcruMut = useMutation({
    mutationFn: (stockEcruId: number) => apiFetch(
      `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/ecru/${stockEcruId}`,
      { method: 'PUT' }
    ),
    onSuccess: (payload: PiecesPayload) => {
      queryClient.setQueryData(queryKey, payload)
      patchLinePrix(payload.prix)
      onSuccess()
    },
  })

  const unlinkEcruMut = useMutation({
    mutationFn: (stockEcruId: number) => apiFetch(
      `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/ecru/${stockEcruId}`,
      { method: 'DELETE' }
    ),
    onSuccess: (payload: PiecesPayload) => {
      queryClient.setQueryData(queryKey, payload)
      patchLinePrix(payload.prix)
      onSuccess()
    },
  })

  const editFiniMut = useMutation({
    mutationFn: (vars: { stockFiniId: number; observations: string; observation_sst: string }) => apiFetch(
      `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/fini/${vars.stockFiniId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observations: vars.observations, observation_sst: vars.observation_sst }),
      },
    ),
    onSuccess: (payload: PiecesPayload) => {
      queryClient.setQueryData(queryKey, payload)
      onSuccess()
    },
  })

  const [editFiniTarget, setEditFiniTarget] = useState<StockFiniLite | null>(null)
  const [showLinkEcruDialog, setShowLinkEcruDialog] = useState(false)
  const [activeTab, setActiveTab] = useState<'affectes' | 'reception'>('reception')
  // Multi-select on linked écru rolls drives the batch-reception dialog.
  // Selection persists across tab switches but resets when the drawer
  // remounts on a different ligne (state lives in PiecesDrawer scope).
  // `lastSelectedEcruIdRef` is the anchor for Shift+click range selection
  // — set on every plain click, kept stable across Shift+clicks (matches
  // the OS file-manager behaviour the user expects).
  const [selectedEcruIds, setSelectedEcruIds] = useState<Set<number>>(new Set())
  const [showBatchReception, setShowBatchReception] = useState(false)
  const lastSelectedEcruIdRef = useRef<number | null>(null)
  // Mirror of the affectés multi-select for the reception tab: lets the
  // visiteur pick rolls currently "en reprise" (IDetat_stock_fini = 2)
  // and re-edit them in batch via the reprise mode of BatchReceptionDialog.
  const [selectedFiniIds, setSelectedFiniIds] = useState<Set<number>>(new Set())
  const [showBatchReprise, setShowBatchReprise] = useState(false)
  const lastSelectedFiniIdRef = useRef<number | null>(null)

  const ecruLinked = useMemo(
    () => (data?.ecruLinked ?? []).slice().sort(byNumeroAsc),
    [data?.ecruLinked],
  )

  const handleEcruClick = useCallback((id: number, shiftKey: boolean) => {
    const ids = ecruLinked.map((r) => r.IDstock_ecru)
    const anchor = lastSelectedEcruIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelectedEcruIds((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(ids[i])
          return next
        })
        return
      }
    }
    // Plain click — toggle this row and become the new anchor.
    setSelectedEcruIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastSelectedEcruIdRef.current = id
  }, [ecruLinked])
  const ecruAvailable = data?.ecruAvailable ?? []
  const finiReceived = useMemo(
    () => (data?.finiReceived ?? []).slice().sort(byNumeroAsc),
    [data?.finiReceived],
  )

  // Only "En reprise" rolls are selectable for the reprendre batch.
  const finiReprisableIds = useMemo<number[]>(
    () => finiReceived.filter((r) => Number(r.IDetat_stock_fini) === 2).map((r) => r.IDstock_fini),
    [finiReceived],
  )

  const handleFiniClick = useCallback((id: number, shiftKey: boolean) => {
    const ids = finiReprisableIds
    const anchor = lastSelectedFiniIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelectedFiniIds((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(ids[i])
          return next
        })
        return
      }
    }
    setSelectedFiniIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastSelectedFiniIdRef.current = id
  }, [finiReprisableIds])

  // Roll-up still used by the "Affectés" section header below the tab bar.
  const totalKgAffectes = ecruLinked.reduce((s, r) => s + (Number(r.poids) || 0), 0)
  const totalMlReception = finiReceived.reduce((s, r) => s + (Number(r.metrage) || 0), 0)

  const tabs = [
    { key: 'reception' as const, label: 'Réception', icon: FiniRollIcon },
    { key: 'affectes' as const, label: 'Affectés', icon: TmRollIcon },
  ]

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
      {/* Tab strip — gold-pill active state matches the right DetailSidebar. */}
      <div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
                active
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t.label}</span>
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-1 pr-1">
          {!commandeSoldee && activeTab === 'affectes' && selectedEcruIds.size > 0 && (
            <Button
              variant="gold"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setShowBatchReception(true)}
            >
              Réceptionner ({selectedEcruIds.size})
            </Button>
          )}
          {!commandeSoldee && activeTab === 'reception' && selectedFiniIds.size > 0 && (
            <Button
              variant="gold"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setShowBatchReprise(true)}
            >
              Reprendre ({selectedFiniIds.size})
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

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

        {!isLoading && !isError && activeTab === 'affectes' && (() => {
          // Per-écru lock: only the rolls that have a fini linked back
          // via `stock_fini.IDstock_ecru` are considered "received".
          // Those rolls hide their unlink button AND can't be selected
          // for a new reception (no duplicate fini per écru). Other
          // linked rolls remain fully interactive.
          const ecruIdsWithFini = new Set(
            finiReceived.map((f) => Number(f.IDstock_ecru)).filter((id) => id > 0)
          )
          const selectableEcrus = ecruLinked.filter((r) => !ecruIdsWithFini.has(r.IDstock_ecru))
          const allSelected = selectableEcrus.length > 0 && selectableEcrus.every((r) => selectedEcruIds.has(r.IDstock_ecru))
          const selectAll = () => setSelectedEcruIds(new Set(selectableEcrus.map((r) => r.IDstock_ecru)))
          const clearSelection = () => setSelectedEcruIds(new Set())
          return (
          <>
            {/* Linked écru rolls */}
            <section>
              <div className="relative flex items-center justify-between mb-1.5">
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
                  Tombé métier — affectés ({ecruLinked.length}{ecruLinked.length > 0 ? ` · ${fmtNum(totalKgAffectes, 1)} kg` : ''})
                </h3>
                {!commandeSoldee && selectableEcrus.length > 0 && (
                  <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 pointer-events-none">
                    <button
                      type="button"
                      onClick={selectAll}
                      disabled={allSelected}
                      className="pointer-events-auto text-[11px] text-accent hover:underline disabled:text-muted-foreground/50 disabled:no-underline disabled:cursor-default px-1"
                    >
                      Tout sélectionner
                    </button>
                    <span className="text-muted-foreground/40 text-[11px]">·</span>
                    <button
                      type="button"
                      onClick={clearSelection}
                      disabled={selectedEcruIds.size === 0}
                      className="pointer-events-auto text-[11px] text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:cursor-default px-1"
                    >
                      Aucun
                    </button>
                  </div>
                )}
                {!commandeSoldee && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-accent hover:text-accent hover:bg-accent/10"
                    onClick={() => setShowLinkEcruDialog(true)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Affecter
                  </Button>
                )}
              </div>
              {ecruLinked.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">Aucun rouleau affecté.</p>
              ) : (
                <div className="space-y-1.5">
                  {ecruLinked.map((roll) => {
                    const received = ecruIdsWithFini.has(roll.IDstock_ecru)
                    return (
                      <EcruRollRow
                        key={roll.IDstock_ecru}
                        roll={roll}
                        action="unlink"
                        onAction={() => unlinkEcruMut.mutate(roll.IDstock_ecru)}
                        isBusy={unlinkEcruMut.isPending && unlinkEcruMut.variables === roll.IDstock_ecru}
                        hideAction={received}
                        selectable={!commandeSoldee && !received}
                        selected={selectedEcruIds.has(roll.IDstock_ecru)}
                        onSelectToggle={(shiftKey) => handleEcruClick(roll.IDstock_ecru, shiftKey ?? false)}
                        received={received}
                      />
                    )
                  })}
                </div>
              )}
            </section>
            {showLinkEcruDialog && (
              <LinkEcruDialog
                available={ecruAvailable}
                sousTraitantNom={sousTraitantNom}
                onBulkLink={async (ids) => {
                  for (const id of ids) {
                    await linkEcruMut.mutateAsync(id)
                  }
                }}
                onClose={() => setShowLinkEcruDialog(false)}
              />
            )}
          </>
          )
        })()}

        {!isLoading && !isError && activeTab === 'reception' && (
          <>
            {/* Réceptions finis */}
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                  Rouleaux finis reçus ({finiReceived.length}{finiReceived.length > 0 ? ` · ${fmtNum(totalMlReception, 1)} Ml` : ''})
                </h3>
                {!commandeSoldee && finiReceived.length === 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:bg-accent/10"
                    onClick={() => setActiveTab('affectes')}
                  >
                    Sélectionner dans Affectés →
                  </Button>
                )}
              </div>
              {finiReceived.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">Aucun rouleau reçu pour le moment.</p>
              ) : (
                <div className="space-y-1.5">
                  {finiReceived.map((roll) => {
                    const enReprise = Number(roll.IDetat_stock_fini) === 2
                    return (
                      <FiniRollRow
                        key={roll.IDstock_fini}
                        roll={roll}
                        onEdit={() => setEditFiniTarget(roll)}
                        disabled={commandeSoldee}
                        selectable={!commandeSoldee && enReprise}
                        selected={selectedFiniIds.has(roll.IDstock_fini)}
                        onSelectToggle={(shiftKey) => handleFiniClick(roll.IDstock_fini, shiftKey ?? false)}
                      />
                    )
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {editFiniTarget && (
        <EditFiniRollDialog
          roll={editFiniTarget}
          isPending={editFiniMut.isPending}
          onCancel={() => setEditFiniTarget(null)}
          onSave={(observations, observation_sst) => {
            editFiniMut.mutate(
              { stockFiniId: editFiniTarget.IDstock_fini, observations, observation_sst },
              { onSuccess: () => setEditFiniTarget(null) },
            )
          }}
        />
      )}
      {showBatchReception && (
        <BatchReceptionDialog
          commandeId={commandeId}
          ligne={ligne}
          ecruRolls={ecruLinked.filter((r) => selectedEcruIds.has(r.IDstock_ecru))}
          onClose={() => setShowBatchReception(false)}
          onSuccess={(payload) => {
            queryClient.setQueryData(queryKey, payload)
            onSuccess()
            setShowBatchReception(false)
            setSelectedEcruIds(new Set())
            setActiveTab('reception')
          }}
        />
      )}
      {showBatchReprise && (
        <BatchReceptionDialog
          mode="reprise"
          commandeId={commandeId}
          ligne={ligne}
          finiRolls={finiReceived.filter((r) => selectedFiniIds.has(r.IDstock_fini))}
          onClose={() => setShowBatchReprise(false)}
          onSuccess={(payload) => {
            queryClient.setQueryData(queryKey, payload)
            onSuccess()
            setShowBatchReprise(false)
            setSelectedFiniIds(new Set())
          }}
        />
      )}
    </div>
  )
}

// Tricoteur drawer (line.type === 1). Two tabs:
//   • Réception — stock_ecru rolls produced for this line. "+ Créer rouleau"
//     button opens the TricoteurReceptionDialog.
//   • Stock fil — every stock_fil row whose (IDref_fil, IDcolori_fil)
//     appears in composition_ecru for the line's IDref_ecru + IDcolori_ecru.
//     Multi-select to drive Affecter / Finir le lot X / Désaffecter.
function TricoteurDrawer({
  commandeId, ligne, commandeSoldee, onClose,
}: {
  commandeId: number
  ligne: LigneCommande
  /** True when the parent commande is `est_soldee = 1` (terminée). In
   *  that state the drawer is read-only: no lot selection, no Affecter /
   *  Finir / Désaffecter buttons, no "+ Créer rouleau" affordance. Matches
   *  the ennoblisseur PiecesDrawer's `commandeSoldee` semantics. */
  commandeSoldee: boolean
  onClose: () => void
}) {
  const queryKey = ['commande-sst-pieces-fil', commandeId, ligne.IDligne_commande_sous_traitant] as const
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery<TricoteurPiecesPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces-fil`),
  })

  const [activeTab, setActiveTab] = useState<'reception' | 'stock-fil'>('reception')
  const [selectedLotIds, setSelectedLotIds] = useState<Set<number>>(new Set())
  const [planError, setPlanError] = useState<string | null>(null)
  const [showDesaffecterConfirm, setShowDesaffecterConfirm] = useState(false)
  const [showReceptionDialog, setShowReceptionDialog] = useState(false)

  const ecruProduced = data?.ecruProduced ?? []
  const stockFil = data?.stockFil ?? []
  const affectations = data?.affectations ?? []
  const targetQtyKg = data?.targetQtyKg ?? 0
  const compositionPairs = data?.compositionPairs ?? []
  const totalKgReception = ecruProduced.reduce((s, r) => s + (Number(r.poids) || 0), 0)
  const totalKgStock = stockFil.reduce((s, r) => s + (Number(r.stock) || 0), 0)
  const hasAffectations = affectations.length > 0

  const toggleLot = useCallback((id: number) => {
    setSelectedLotIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    setPlanError(null)
  }, [])

  // Coverage — every required composition pair must have at least one
  // selected lot in the same (IDref_fil, IDcolori_fil) bucket. Without
  // full coverage we hide the Affecter / Finir buttons entirely (per
  // legacy UX). `missingPairs` drives the hint banner.
  const { coveredAll, missingPairs, limitingLotLabel } = useMemo(() => {
    if (compositionPairs.length === 0) {
      return { coveredAll: false, missingPairs: [] as TricoteurCompositionPair[], limitingLotLabel: null as string | null }
    }
    const selected = stockFil.filter((r) => selectedLotIds.has(r.IDstock_fil))
    const bucketKey = (rf: number, cf: number) => `${rf}:${cf}`
    const lotsByBucket = new Map<string, StockFilLite[]>()
    for (const l of selected) {
      const k = bucketKey(l.IDref_fil, l.IDcolori_fil ?? 0)
      const arr = lotsByBucket.get(k) ?? []
      arr.push(l)
      lotsByBucket.set(k, arr)
    }
    const missing: TricoteurCompositionPair[] = []
    for (const p of compositionPairs) {
      const k = bucketKey(p.IDref_fil, p.IDcolori_fil)
      if ((lotsByBucket.get(k) ?? []).length === 0) missing.push(p)
    }
    const covered = missing.length === 0

    // Limiting lot — match the server algorithm exactly: producible =
    // stock_sum_in_bucket / (pourcentage / 100); pick the smallest, then
    // the oldest lot in that bucket by date_entree.
    let label: string | null = null
    if (covered) {
      let smallestProducible = Infinity
      let smallestBucketLots: StockFilLite[] = []
      for (const p of compositionPairs) {
        const k = bucketKey(p.IDref_fil, p.IDcolori_fil)
        const bucket = lotsByBucket.get(k) ?? []
        const sum = bucket.reduce((s, l) => s + (Number(l.stock) || 0), 0)
        const pct = p.pourcentage / 100
        if (pct <= 0) continue
        const producible = sum / pct
        if (producible < smallestProducible) {
          smallestProducible = producible
          smallestBucketLots = bucket
        }
      }
      smallestBucketLots.sort((a, b) => (a.date_entree || '').localeCompare(b.date_entree || ''))
      label = smallestBucketLots[0]?.lot ?? null
    }
    return { coveredAll: covered, missingPairs: missing, limitingLotLabel: label }
  }, [selectedLotIds, stockFil, compositionPairs])

  const affecterMut = useMutation({
    mutationFn: (mode: 'standard' | 'finir') => apiFetch(
      `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/affecter`,
      {
        method: 'POST',
        body: JSON.stringify({ stockFilIds: Array.from(selectedLotIds), mode }),
      },
    ),
    onSuccess: (resp: any) => {
      setSelectedLotIds(new Set())
      setPlanError(null)
      if (resp?.payload) queryClient.setQueryData(queryKey, resp.payload)
      // Refresh the parent detail too (line qty may have changed in 'finir' mode).
      queryClient.invalidateQueries({ queryKey: ['commande-sst', commandeId] })
    },
    onError: (err: any) => {
      // Server responses: { error: 'plan_invalid', messages: [...] } or
      // { error: 'affectations_exist', message: '...' }.
      const body = (err && typeof err === 'object' && 'body' in err) ? (err as any).body : null
      if (body?.messages?.length) setPlanError(body.messages.join(' '))
      else if (body?.message) setPlanError(body.message)
      else setPlanError('Erreur lors de l\'affectation.')
    },
  })

  const desaffecterMut = useMutation({
    mutationFn: () => apiFetch(
      `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/affectations`,
      { method: 'DELETE' },
    ),
    onSuccess: (resp: any) => {
      setSelectedLotIds(new Set())
      setPlanError(null)
      setShowDesaffecterConfirm(false)
      if (resp?.payload) queryClient.setQueryData(queryKey, resp.payload)
    },
    onError: (err: any) => {
      const body = (err && typeof err === 'object' && 'body' in err) ? (err as any).body : null
      setPlanError(body?.message ?? 'Erreur lors de la désaffectation.')
      setShowDesaffecterConfirm(false)
    },
  })

  const tabs = [
    { key: 'reception' as const, label: 'Réception', icon: TmRollIcon },
    { key: 'stock-fil' as const, label: 'Stock fil', icon: BobineIcon },
  ]

  // Every write affordance is gated on `!commandeSoldee` — a terminée
  // commande is read-only (the backend also refuses writes via
  // refuseIfTerminee, but hiding the buttons keeps the UI honest).
  const canAffect = !commandeSoldee && !hasAffectations && coveredAll && targetQtyKg > 0
  const canFinir = !commandeSoldee && !hasAffectations && coveredAll && limitingLotLabel != null

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
      {/* Tab strip — gold-pill active state matches PiecesDrawer. */}
      <div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
                active
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t.label}</span>
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-1 pr-1">
          {activeTab === 'reception' && hasAffectations && !commandeSoldee && (
            <Button
              variant="gold"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setShowReceptionDialog(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Créer rouleau
            </Button>
          )}
          {activeTab === 'stock-fil' && canAffect && (
            <Button
              variant="gold"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={affecterMut.isPending}
              onClick={() => affecterMut.mutate('standard')}
            >
              Affecter ({fmtNum(targetQtyKg, 1)} kg)
            </Button>
          )}
          {activeTab === 'stock-fil' && canFinir && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={affecterMut.isPending}
              onClick={() => affecterMut.mutate('finir')}
              title="Calcule la quantité maximum produisible en consommant entièrement le lot le plus limitant des lots sélectionnés."
            >
              Finir le lot {limitingLotLabel}
            </Button>
          )}
          {activeTab === 'stock-fil' && hasAffectations && !commandeSoldee && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={desaffecterMut.isPending}
              onClick={() => setShowDesaffecterConfirm(true)}
            >
              <Unlink className="h-3.5 w-3.5 mr-1" />
              Désaffecter
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
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

        {planError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {planError}
          </div>
        )}

        {!isLoading && !isError && activeTab === 'reception' && (
          <>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                {ecruProduced.length === 0
                  ? 'Aucune réception'
                  : `${ecruProduced.length} rouleau${ecruProduced.length > 1 ? 'x' : ''} · ${fmtNum(totalKgReception, 1)} kg`}
              </h3>
            </div>
            {ecruProduced.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <TmRollIcon className="h-12 w-12 mb-2 opacity-40" />
                <p className="text-sm">Aucune réception pour cette ligne</p>
              </div>
            ) : (
              <div className="space-y-2">
                {ecruProduced.map((roll) => (
                  <EcruRollRow
                    key={roll.IDstock_ecru}
                    roll={roll}
                    action="unlink"
                    onAction={() => {}}
                    isBusy={false}
                    hideAction
                  />
                ))}
              </div>
            )}
          </>
        )}

        {!isLoading && !isError && activeTab === 'stock-fil' && (
          <>
            {!commandeSoldee && !hasAffectations && compositionPairs.length > 0 && missingPairs.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900">
                <p className="font-medium mb-1">Composition à couvrir :</p>
                <ul className="space-y-0.5">
                  {compositionPairs.map((p) => {
                    const stillMissing = missingPairs.some(
                      (m) => m.IDref_fil === p.IDref_fil && m.IDcolori_fil === p.IDcolori_fil,
                    )
                    const label = `${p.ref_fil_reference ?? `#${p.IDref_fil}`}${p.colori_reference ? ` · ${p.colori_reference}` : ''} (${p.pourcentage}%)`
                    return (
                      <li key={`${p.IDref_fil}:${p.IDcolori_fil}`} className="flex items-center gap-1.5">
                        {stillMissing ? (
                          <AlertCircle className="h-3 w-3 text-amber-600 flex-shrink-0" />
                        ) : (
                          <Check className="h-3 w-3 text-green-600 flex-shrink-0" />
                        )}
                        <span className={cn(stillMissing ? 'text-amber-900' : 'text-green-700 line-through')}>{label}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                {stockFil.length === 0
                  ? 'Aucun stock pour cette référence'
                  : `${stockFil.length} bobine${stockFil.length > 1 ? 's' : ''} · ${fmtNum(totalKgStock, 1)} kg`}
              </h3>
              {hasAffectations && (
                <span className="text-[10px] uppercase tracking-wide text-green-700 font-semibold">
                  Affectés · {fmtNum(affectations.reduce((s, a) => s + a.quantite, 0), 1)} kg
                </span>
              )}
            </div>
            {stockFil.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <BobineIcon className="h-12 w-12 mb-2 opacity-40" />
                <p className="text-sm">Aucun stock disponible</p>
              </div>
            ) : (
              <div className="space-y-2">
                {stockFil.map((row) => (
                  <StockFilRow
                    key={row.IDstock_fil}
                    row={row}
                    selectable={!commandeSoldee && !hasAffectations}
                    selected={selectedLotIds.has(row.IDstock_fil)}
                    onToggle={() => toggleLot(row.IDstock_fil)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={showDesaffecterConfirm}
        title="Désaffecter les lots"
        description="Cette action retire toutes les affectations de fil pour cette ligne. Elle est sans effet sur les rouleaux déjà produits."
        confirmLabel="Désaffecter"
        isPending={desaffecterMut.isPending}
        onCancel={() => setShowDesaffecterConfirm(false)}
        onConfirm={() => desaffecterMut.mutate()}
      />

      {showReceptionDialog && (
        <TricoteurReceptionDialog
          commandeId={commandeId}
          ligneId={ligne.IDligne_commande_sous_traitant}
          onClose={() => setShowReceptionDialog(false)}
          onSuccess={(payload) => {
            queryClient.setQueryData(queryKey, payload)
            setShowReceptionDialog(false)
            setActiveTab('reception')
          }}
        />
      )}
    </div>
  )
}

function StockFilRow({
  row, selectable = false, selected = false, onToggle,
}: {
  row: StockFilLite
  /** When true, the whole card toggles selection on click and a checkbox
   *  leads the row. Set to false when affectations already exist (the
   *  buttons switch to Désaffecter; selection becomes irrelevant). */
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
}) {
  const refLabel = row.ref_fil_reference || `Ref #${row.IDref_fil}`
  const lotChips = [
    row.lot ? `lot ${row.lot}` : '',
    row.lot_frs ? `lot frs ${row.lot_frs}` : '',
  ].filter((s) => s.length > 0)
  const affecteKg = Number(row.affecte_kg) || 0

  return (
    <div
      onClick={selectable ? onToggle : undefined}
      className={cn(
        'rounded-lg border bg-card shadow-sm p-3 transition-colors select-none',
        selectable && 'cursor-pointer hover:border-accent/40',
        selected ? 'border-accent ring-1 ring-accent/40 bg-accent/[0.03]' : 'border-border/60',
        affecteKg > 0 && !selected && 'border-green-500/40 bg-green-500/[0.03]',
      )}
    >
      <div className="flex items-center gap-3">
        {selectable && (
          <Checkbox
            checked={selected}
            onClick={(e) => { e.stopPropagation(); onToggle?.() }}
            className="flex-shrink-0"
          />
        )}
        <div className="h-10 w-10 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
          <BobineIcon className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">
              {refLabel}
              {row.colori_reference && (
                <span className="text-muted-foreground"> / {row.colori_reference}</span>
              )}
            </span>
            {lotChips.map((c) => (
              <span key={c} className="text-xs text-muted-foreground truncate">· {c}</span>
            ))}
            {affecteKg > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-green-700 bg-green-500/10 border border-green-500/30 rounded px-1.5 py-0.5">
                affecté {fmtNum(affecteKg, 1)} kg
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums flex-wrap">
            {Number(row.stock) > 0 && (
              <span className="font-medium text-foreground">{fmtNum(Number(row.stock), 1)} kg</span>
            )}
            {row.fournisseur_nom && <span>· {row.fournisseur_nom}</span>}
            {row.magasin_nom && <span>· {row.magasin_nom}</span>}
            {row.emplacement && <span>· {row.emplacement}</span>}
            {row.date_entree && <span>· entré {formatHfsqlDate(row.date_entree)}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// Reception dialog for tricoteur lines — creates stock_ecru rolls one at
// a time. Modeled on the ennoblisseur BatchReceptionDialog: gold-gradient
// header + accent-edge editor card + zinc-tinted bottom list + zinc-tinted
// footer (see mps_designer §18 + §32 for the shared shapes). Differences
// vs the ennoblisseur dialog:
//   - Rolls are CREATED from scratch (vs ennoblisseur transforming pre-
//     selected écru rolls). Starts with 1 empty draft; user clicks
//     "Ajouter un rouleau" to extend.
//   - No metrage (tricoteur deliveries are weight-based).
//   - No "défaut ennoblisseur" textarea — only one observations field
//     plus a second_choix flag.
//   - No Tricobot autofill, no "reprise" mode.
function TricoteurReceptionDialog({
  commandeId, ligneId, onClose, onSuccess,
}: {
  commandeId: number
  ligneId: number
  onClose: () => void
  onSuccess: (payload: TricoteurPiecesPayload) => void
}) {
  interface RollDraft {
    numero: string
    lot: string
    poids: string  // kept as string for the controlled input; parsed on save
    observations: string
    second_choix: boolean
  }
  const blank = (): RollDraft => ({ numero: '', lot: '', poids: '', observations: '', second_choix: false })
  const [rolls, setRolls] = useState<RollDraft[]>(() => [blank()])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [visitedKeys, setVisitedKeys] = useState<Set<number>>(() => new Set([0]))
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [doneCount, setDoneCount] = useState(0)

  const current = rolls[currentIdx] ?? blank()
  const canPrev = currentIdx > 0
  const canNext = currentIdx < rolls.length - 1
  const canSubmit = rolls.length > 0 && !submitting

  const updateCurrent = (patch: Partial<RollDraft>) => {
    setRolls((prev) => prev.map((r, i) => (i === currentIdx ? { ...r, ...patch } : r)))
  }

  // Sticky-lot carryover on navigation: if destination has empty lot AND
  // current has one, inherit. Matches the ennoblisseur dialog's behaviour.
  const goTo = (next: number) => {
    if (next < 0 || next >= rolls.length) return
    setRolls((prev) => {
      const dest = prev[next]
      const src = prev[currentIdx]
      if (dest && src && dest.lot.trim() === '' && src.lot.trim() !== '') {
        return prev.map((r, i) => (i === next ? { ...r, lot: src.lot } : r))
      }
      return prev
    })
    setVisitedKeys((prev) => {
      if (prev.has(next)) return prev
      const nextSet = new Set(prev); nextSet.add(next); return nextSet
    })
    setCurrentIdx(next)
  }

  const addRoll = () => {
    setRolls((prev) => {
      const lastLot = prev[currentIdx]?.lot ?? ''
      return [...prev, { ...blank(), lot: lastLot }]
    })
    setCurrentIdx(rolls.length)
    setVisitedKeys((prev) => { const n = new Set(prev); n.add(rolls.length); return n })
  }

  const removeRoll = (idx: number) => {
    if (rolls.length === 1) return
    setRolls((prev) => prev.filter((_, i) => i !== idx))
    setCurrentIdx((prev) => Math.max(0, Math.min(prev, rolls.length - 2)))
  }

  const validateRoll = (r: RollDraft): string | null => {
    if (r.numero.trim().length === 0) return 'Le numéro est obligatoire.'
    const poids = Number(r.poids.replace(',', '.'))
    if (!isFinite(poids) || poids <= 0) return 'Le poids doit être supérieur à 0.'
    return null
  }

  const handleSubmit = async () => {
    setError(null)
    setSubmitting(true)
    setDoneCount(0)
    // Validate first; jump to the first invalid roll on failure.
    for (let i = 0; i < rolls.length; i++) {
      const err = validateRoll(rolls[i])
      if (err) {
        setCurrentIdx(i)
        setError(`Rouleau ${i + 1} : ${err}`)
        setSubmitting(false)
        return
      }
    }
    let lastPayload: TricoteurPiecesPayload | null = null
    for (let i = 0; i < rolls.length; i++) {
      const r = rolls[i]
      try {
        const resp = await apiFetch<{ ok: boolean; payload: TricoteurPiecesPayload }>(
          `/commandes-sous-traitant/${commandeId}/lignes/${ligneId}/pieces-fil/rolls`,
          {
            method: 'POST',
            body: JSON.stringify({
              numero: r.numero.trim(),
              lot: r.lot.trim() || undefined,
              poids: Number(r.poids.replace(',', '.')),
              observations: r.observations.trim() || undefined,
              second_choix: r.second_choix ? 1 : 0,
            }),
          },
        )
        if (resp?.payload) lastPayload = resp.payload
        setDoneCount((n) => n + 1)
      } catch (err: any) {
        const body = (err && typeof err === 'object' && 'body' in err) ? (err as any).body : null
        setError(`Rouleau ${i + 1} : ${body?.message ?? body?.error ?? (err instanceof Error ? err.message : 'erreur serveur')}`)
        setSubmitting(false)
        return
      }
    }
    setSubmitting(false)
    if (lastPayload) onSuccess(lastPayload)
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent
        className="max-w-3xl w-[92vw] h-[88vh] flex flex-col p-0 overflow-hidden"
        onClose={submitting ? undefined : onClose}
      >
        {/* Header — gold gradient + icon box, mirrors BatchReceptionDialog. */}
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <TmRollIcon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">
              Créer {rolls.length > 1 ? `${rolls.length} rouleaux` : 'un rouleau'} écru
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              Rouleau {currentIdx + 1} sur {rolls.length}
            </p>
          </div>
        </div>

        {/* Editor card — gold-edge accent, mirrors the ennoblisseur card. */}
        <div className="flex-shrink-0 px-6 pt-4">
          <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-accent/[0.03] p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
                  <TmRollIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {current.numero.trim() || <span className="text-muted-foreground italic">Rouleau {currentIdx + 1}</span>}
                  </p>
                  {current.lot.trim().length > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">lot {current.lot}</p>
                  )}
                </div>
              </div>
              {rolls.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => removeRoll(currentIdx)}
                  disabled={submitting}
                  title="Retirer ce rouleau"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <LabeledInput
                label="N° rouleau"
                value={current.numero}
                onChange={(v) => updateCurrent({ numero: v })}
                autoFocus
              />
              <LabeledInput
                label="Lot"
                value={current.lot}
                onChange={(v) => updateCurrent({ lot: v })}
                helper="Reporté aux rouleaux suivants."
              />
              <LabeledInput
                label="Poids (kg)"
                type="number"
                value={current.poids}
                onChange={(v) => updateCurrent({ poids: v })}
              />
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-2 items-start">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-blue-700 flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" />
                  Observations
                </label>
                <textarea
                  value={current.observations}
                  onChange={(e) => updateCurrent({ observations: e.target.value })}
                  rows={2}
                  className="w-full rounded-md border border-blue-300 bg-white ring-1 ring-blue-100 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />
              </div>
              <label className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/60 bg-white cursor-pointer select-none whitespace-nowrap mt-[18px]">
                <Checkbox
                  checked={current.second_choix}
                  onCheckedChange={(c) => updateCurrent({ second_choix: !!c })}
                />
                <span className="text-xs font-medium">2<sup>e</sup> choix</span>
              </label>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button variant="outline" size="sm" onClick={() => goTo(currentIdx - 1)} disabled={!canPrev || submitting}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Précédent
              </Button>
              <Button variant="outline" size="sm" onClick={() => goTo(currentIdx + 1)} disabled={!canNext || submitting}>
                Suivant <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>

        {/* Bottom roll list — compact summary, click-to-jump.
            Includes "+ Ajouter un rouleau" trailing card. */}
        <div className="flex-1 min-h-0 flex flex-col border-t mt-4 bg-zinc-100/80">
          <div className="flex-shrink-0 px-6 pt-3 pb-1.5 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Aperçu des {rolls.length} rouleau{rolls.length > 1 ? 'x' : ''}
            </p>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-accent hover:text-accent hover:bg-accent/10" onClick={addRoll} disabled={submitting}>
              <Plus className="h-3 w-3 mr-1" />
              Ajouter un rouleau
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3 space-y-1 scrollbar-transparent">
            {rolls.map((r, i) => {
              const isCurrent = i === currentIdx
              const isVisited = visitedKeys.has(i)
              const hasObs = r.observations.trim().length > 0
              const hasPoids = Number(r.poids.replace(',', '.')) > 0
              const hasNumero = r.numero.trim().length > 0
              const hasData = hasNumero || hasPoids || r.lot.trim().length > 0 || hasObs
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    'w-full rounded-md border bg-card p-2 text-left text-xs flex items-center gap-2 transition-colors',
                    isCurrent
                      ? 'border-accent ring-1 ring-accent shadow-[inset_3px_0_0_0_rgb(242_184_10)]'
                      : 'border-border/60 hover:border-accent/40',
                  )}
                >
                  <div className={cn(
                    'h-5 w-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-semibold tabular-nums',
                    isCurrent ? 'bg-accent text-accent-foreground'
                      : hasNumero && hasPoids ? 'bg-accent/15 text-accent'
                      : isVisited ? 'bg-zinc-200 text-foreground'
                      : 'bg-zinc-100 text-muted-foreground',
                  )}>
                    {hasNumero && hasPoids && !isCurrent ? <Check className="h-3 w-3" /> : i + 1}
                  </div>
                  <span className="font-semibold truncate flex-shrink-0 max-w-[140px]">
                    {r.numero.trim() || <span className="italic text-muted-foreground">— en attente</span>}
                  </span>
                  <div className="flex items-center gap-2 tabular-nums text-muted-foreground min-w-0 flex-1 truncate">
                    {r.lot.trim() && <span className="truncate">lot {r.lot}</span>}
                    {hasPoids && <span>· {fmtNum(Number(r.poids.replace(',', '.')), 1)} kg</span>}
                    {!hasData && <span className="italic">— en attente</span>}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {r.second_choix && (
                      <span className="text-[9px] font-bold uppercase tracking-wide text-red-700 bg-red-500/10 border border-red-500/30 rounded px-1 py-0.5">2<sup>e</sup></span>
                    )}
                    {hasObs && <MessageSquare className="h-3 w-3 text-blue-600" />}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Footer — zinc bar with error banner + actions. */}
        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Annuler</Button>
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting
                ? `Enregistrement... (${doneCount}/${rolls.length})`
                : `Créer ${rolls.length > 1 ? `${rolls.length} rouleaux` : 'le rouleau'}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EcruRollRow({
  roll, action, onAction, isBusy, hideAction,
  selectable = false, selected = false, onSelectToggle, received = false,
}: {
  roll: StockEcruLite
  action: 'link' | 'unlink'
  onAction: () => void
  isBusy: boolean
  /** When true, the action button is omitted entirely. Used for linked
   *  écru rolls that already have a received fini — at that point the
   *  affectation is locked. */
  hideAction?: boolean
  /** When true, the row gets a leading checkbox and the whole card body
   *  toggles selection on click. Used in the Affectés tab to drive the
   *  batch-reception dialog. `shiftKey` is forwarded so the caller can
   *  implement Shift+click range selection. */
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (shiftKey?: boolean) => void
  /** True when this écru has already produced a stock_fini reception on
   *  the current line. Renders a green "Reçu" tag and visually mutes the
   *  card so the user can see it's done. The card is also non-selectable
   *  and the unlink action is hidden — both governed by the caller via
   *  `selectable={false}` + `hideAction`. */
  received?: boolean
}) {
  return (
    <div
      onClick={selectable ? (e) => onSelectToggle?.(e.shiftKey) : undefined}
      className={cn(
        'group rounded-lg border bg-card shadow-sm p-3 transition-colors select-none',
        selectable && 'cursor-pointer hover:border-accent/40',
        received && 'bg-green-500/[0.04] border-green-500/30',
        selected ? 'border-accent ring-1 ring-accent/40 bg-accent/[0.03]' : !received && 'border-border/60',
      )}
    >
      <div className="flex items-center gap-3">
        {selectable && (
          <Checkbox
            checked={selected}
            onClick={(e) => { e.stopPropagation(); onSelectToggle?.(e.shiftKey) }}
            className="flex-shrink-0"
          />
        )}
        <div className="h-10 w-10 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
          <TmRollIcon className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn('text-sm font-semibold truncate', received && 'text-muted-foreground')}>
              {roll.numero || `#${roll.IDstock_ecru}`}
            </span>
            {roll.lot && (
              <span className="text-xs text-muted-foreground truncate">· lot {roll.lot}</span>
            )}
            {received && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-green-700 bg-green-500/10 border border-green-500/30 rounded px-1.5 py-0.5">
                <Check className="h-3 w-3" />
                Reçu
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums">
            {Number(roll.poids) > 0 && (
              <span className="font-medium text-foreground">{fmtNum(Number(roll.poids), 1)} kg</span>
            )}
            {Number(roll.metrage) > 0 && (
              <span>{fmtNum(Number(roll.metrage), 1)} Ml</span>
            )}
            {roll.date_saisie && (
              <span>entré {formatHfsqlDate(roll.date_saisie)}</span>
            )}
          </div>
        </div>
        {/* Client-reservation tag — sits at the right end of the header
            row, just left of the action button. */}
        {!!roll.client_nom && (
          <Badge
            variant="secondary"
            className="text-xs py-1 px-2 gap-1 flex-shrink-0"
            title="Rouleau réservé à ce client"
          >
            <Building2 className="h-3 w-3" />
            {roll.client_nom}
          </Badge>
        )}
        {!hideAction && (
          action === 'unlink' ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); onAction() }}
              disabled={isBusy}
              title="Retirer ce rouleau de l'affectation"
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={(e) => { e.stopPropagation(); onAction() }}
              disabled={isBusy}
              className="flex-shrink-0"
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
              Affecter
            </Button>
          )
        )}
      </div>
      {/* Notes / defect banner — lives in a separate block below the
          header so its presence never affects the centring of the
          widgets above. Indented `ml-[52px]` (icon box h-10 = 40px + the
          parent flex's gap-3 = 12px) so it lines up with the title text. */}
      <div className="ml-[52px]">
        <RollNotes
          secondChoix={Number(roll.second_choix) > 0}
          observations={[
            { label: null, text: roll.observations?.trim() ?? '' },
          ]}
          defects={roll.defects}
        />
      </div>
    </div>
  )
}

// RollNotes (blue observation / red défaut banners) moved to the shared
// component — also consumed by the Clients/Commandes affectation drawer.

/** Color-coded etat_stock_fini badge. Labels mirror the legacy table:
 *    1=En Contrôle, 2=En Reprise, 3=Validé, 4=Expédié, 5=Attente de décision.
 *  Renders nothing for null / unknown values so older rolls don't get a
 *  misleading default. */
const ETAT_FINI_META: Record<number, { label: string; icon: typeof Check; classes: string }> = {
  1: { label: 'En contrôle',   icon: Eye,         classes: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  2: { label: 'En reprise',    icon: RotateCcw,   classes: 'bg-orange-500/10 text-orange-700 border-orange-500/30' },
  3: { label: 'Validé',        icon: CheckCircle2, classes: 'bg-green-500/10 text-green-700 border-green-500/30' },
  4: { label: 'Expédié',       icon: Truck,       classes: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
  5: { label: 'Attente',       icon: HelpCircle,  classes: 'bg-zinc-300/40 text-muted-foreground border-zinc-400/30' },
}

function EtatFiniBadge({ etat }: { etat: number | null | undefined }) {
  const id = Number(etat) || 0
  const meta = ETAT_FINI_META[id]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span
      title={meta.label}
      className={cn(
        // Sized to match the écru's `client_nom` badge — text-xs / py-1 / px-2.
        'inline-flex items-center gap-1 text-xs font-medium border rounded-md px-2 py-1 flex-shrink-0',
        meta.classes,
      )}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}

function FiniRollRow({
  roll, onEdit, disabled = false,
  selectable = false, selected = false, onSelectToggle,
}: {
  roll: StockFiniLite
  onEdit: () => void
  /** Hide the edit action when the commande is soldée — same rule as
   *  the rest of the pieces drawer: closed commandes are read-only. */
  disabled?: boolean
  /** When true, the row gets a leading checkbox and the whole card body
   *  toggles selection on click. Mirrors EcruRollRow — used in the
   *  Réception tab to drive the "Reprendre X" batch flow. Currently only
   *  set on rolls whose `IDetat_stock_fini === 2` (En reprise). */
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (shiftKey?: boolean) => void
}) {
  return (
    <div
      onClick={selectable ? (e) => onSelectToggle?.(e.shiftKey) : undefined}
      className={cn(
        'group rounded-lg border bg-card shadow-sm p-3 transition-colors select-none',
        selectable && 'cursor-pointer hover:border-accent/40',
        selected ? 'border-accent ring-1 ring-accent/40 bg-accent/[0.03]' : 'border-border/60',
      )}
    >
      {/* Header row — fixed nominal height, vertically-centered badges
          and edit button. Mirrors the écru card layout so the right-side
          chrome lines up with the title + metrics block, not the centre
          of an inflated card (when notes appear below). */}
      <div className="flex items-center gap-3">
        {selectable && (
          <Checkbox
            checked={selected}
            onClick={(e) => { e.stopPropagation(); onSelectToggle?.(e.shiftKey) }}
            className="flex-shrink-0"
          />
        )}
        <div className="h-10 w-10 rounded-md bg-green-500/10 flex items-center justify-center flex-shrink-0">
          <FiniRollIcon className="h-7 w-7 text-green-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">
              {roll.numero || `#${roll.IDstock_fini}`}
            </span>
            {roll.lot && (
              <span className="text-xs text-muted-foreground truncate">· lot {roll.lot}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums">
            {Number(roll.poids) > 0 && (
              <span className="font-medium text-foreground">{fmtNum(Number(roll.poids), 1)} kg</span>
            )}
            {Number(roll.metrage) > 0 && (
              <span>{fmtNum(Number(roll.metrage), 1)} Ml</span>
            )}
            {roll.date_saisie && (
              <span>reçu {formatHfsqlDate(roll.date_saisie)}</span>
            )}
          </div>
        </div>
        <EtatFiniBadge etat={roll.IDetat_stock_fini} />
        {!!roll.client_nom && (
          <Badge
            variant="secondary"
            className="text-xs py-1 px-2 gap-1 flex-shrink-0"
            title="Rouleau réservé à ce client"
          >
            <Building2 className="h-3 w-3" />
            {roll.client_nom}
          </Badge>
        )}
        {!disabled && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-accent flex-shrink-0"
            onClick={(e) => { e.stopPropagation(); onEdit() }}
            title="Modifier les observations"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {/* Notes / defect banner below the header — indented `ml-[52px]`
          (icon box h-10 = 40px + parent flex's gap-3 = 12px) so it lines
          up with the title text. Mirrors the écru pattern. */}
      <div className="ml-[52px]">
        <RollNotes
          secondChoix={Number(roll.second_choix) > 0}
          observations={[
            { label: null, text: roll.observations?.trim() ?? '' },
          ]}
          defautText={roll.observation_sst}
        />
      </div>
    </div>
  )
}

function EditFiniRollDialog({
  roll, isPending, onCancel, onSave,
}: {
  roll: StockFiniLite
  isPending: boolean
  onCancel: () => void
  onSave: (observations: string, observation_sst: string) => void
}) {
  // Two-field edit modal for a received fini roll. Mirrors the colour
  // language of RollNotes: blue = commentaire (visiteur → client),
  // red = défaut (ennoblisseur's report). Other stock_fini columns
  // (numero, lot, poids, …) are intentionally not editable here.
  const [observations, setObservations] = useState(roll.observations ?? '')
  const [observationSst, setObservationSst] = useState(roll.observation_sst ?? '')

  const dirty =
    (observations ?? '') !== (roll.observations ?? '')
    || (observationSst ?? '') !== (roll.observation_sst ?? '')

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !isPending) onCancel() }}>
      <DialogContent className="max-w-lg" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FiniRollIcon className="h-6 w-6 text-accent" />
            Rouleau fini · {roll.numero || `#${roll.IDstock_fini}`}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              Commentaire (visible par le client)
            </label>
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              rows={3}
              autoFocus
              className="w-full rounded-md border border-blue-300 bg-blue-50/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-red-700 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Défaut signalé par l'ennoblisseur
            </label>
            <textarea
              value={observationSst}
              onChange={(e) => setObservationSst(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-red-300 bg-red-50/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-y"
            />
          </div>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onCancel} disabled={isPending}>Annuler</Button>
          <Button
            onClick={() => onSave(observations, observationSst)}
            disabled={!dirty || isPending}
          >
            {isPending ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Batch reception: one stock_fini row per selected écru (two when the
 *  écru is split — see the Couper en deux note below).
 *
 *  Layout — wizard pattern:
 *    - Header band (gold gradient)
 *    - Batch fields (Référence fini + Magasin, apply to all rolls)
 *    - Editor card for the CURRENT roll (Lot / Poids / Métrage + blue
 *      Commentaire + red Défaut textareas + Précédent / Suivant nav)
 *    - Compact list of all rolls at the bottom — each summarises its
 *      entered data, the active row is gold-ringed, click-to-jump
 *    - Footer with Annuler + Réceptionner
 *
 *  Sticky lot carryover: clicking Suivant onto a fresh roll pre-fills
 *  its `lot` field with the current roll's `lot` so the user doesn't
 *  re-type the same value on a batch with one shared lot number. The
 *  carryover never overrides a roll that's been visited before.
 *
 *  Submit fires sequential POSTs to /pieces/fini. If one fails, the
 *  earlier successes stay persisted and the dialog stops on the error
 *  so the user can fix and retry the remainder.
 *
 *  Couper en deux: the dyer sometimes returns a single roll cut into two
 *  physical pieces. Toggling `split` on a roll turns it into two fini
 *  rows on submit — `<numero>-1` (poids / metrage) and `<numero>-2`
 *  (poids2 / metrage2). In create mode both rows POST and point at the
 *  same source écru; in reprise mode the existing stock_fini row is
 *  PATCHed into piece 1 (renamed) and piece 2 POSTs as a new row keeping
 *  the original's écru / coloris / magasin. Matches legacy FEN_Coupe_Fini.
 */
interface BatchReceptionRow {
  lot: string
  poids: string
  metrage: string
  observations: string
  observation_sst: string
  /** When true the roll yields two fini rows on submit (see couper note). */
  split: boolean
  /** Poids / metrage of the second piece — only read when `split`. */
  poids2: string
  metrage2: string
}

type BatchReceptionProps = {
  commandeId: number
  ligne: LigneCommande
  onClose: () => void
  onSuccess: (payload: PiecesPayload) => void
} & (
  | { mode?: 'create'; ecruRolls: StockEcruLite[]; finiRolls?: undefined }
  | { mode: 'reprise'; finiRolls: StockFiniLite[]; ecruRolls?: undefined }
)

// Natural ascending comparator by roll numéro — "3377/1, 3377/2, 3377/22"
// (numeric collation handles the /N suffix, not lexicographic). Shared by the
// reception dialog, the Affectés list, and the Réception list.
function byNumeroAsc(a: { numero: string | null }, b: { numero: string | null }): number {
  return (a.numero ?? '').localeCompare(b.numero ?? '', undefined, { numeric: true, sensitivity: 'base' })
}

function BatchReceptionDialog(props: BatchReceptionProps) {
  const { commandeId, ligne, onClose, onSuccess } = props
  const isReprise = props.mode === 'reprise'

  // Type-narrowed locals: TS can't follow `isReprise` back to the
  // discriminated union, so we resolve the arrays once via the mode
  // discriminator and pass the narrowed values through the rest of the
  // component. The "off" array is `[]` and never read.
  const ecruRolls: StockEcruLite[] = props.mode === 'reprise' ? [] : props.ecruRolls
  const finiRolls: StockFiniLite[] = props.mode === 'reprise' ? props.finiRolls : []

  // In create mode we iterate over écru rolls (one fini row per écru); in
  // reprise mode we iterate over the existing fini rolls and PATCH them.
  // The wizard, sticky-lot carryover, and submit progress all key on the
  // same "row id" (écru id for create, fini id for reprise).
  const rolls: Array<{ id: number; numero: string | null; lot: string | null; poidsRef: number | null }> = (
    isReprise
      ? finiRolls.map((r) => ({
          id: r.IDstock_fini, numero: r.numero, lot: r.lot, poidsRef: Number(r.poids) || null,
        }))
      : ecruRolls.map((r) => ({
          id: r.IDstock_ecru, numero: r.numero, lot: r.lot, poidsRef: Number(r.poids) || null,
        }))
  ).sort(byNumeroAsc)

  // Référence fini and Magasin are no longer user-editable here; both
  // default once and apply to the whole batch. IDref_fini is taken from
  // the ennoblisseur line's target ref; IDmagasin stays 0 (server-side
  // default behaviour is preserved).
  const idRefFini = Number(ligne.IDreference) || 0
  const idMagasin = 0

  const [rows, setRows] = useState<Record<number, BatchReceptionRow>>(() => {
    const initial: Record<number, BatchReceptionRow> = {}
    if (isReprise) {
      // Pre-fill from the existing stock_fini values — the visiteur edits
      // them and submits, which PATCHes each row and resets the etat back
      // to 1 (En contrôle) server-side.
      for (const r of finiRolls) {
        const poids = Number(r.poids)
        const metrage = Number(r.metrage)
        initial[r.IDstock_fini] = {
          lot: (r.lot ?? '').trim(),
          poids: poids > 0 ? poids.toFixed(1) : '',
          metrage: metrage > 0 ? metrage.toFixed(1) : '',
          observations: r.observations ?? '',
          observation_sst: r.observation_sst ?? '',
          split: false,
          poids2: '',
          metrage2: '',
        }
      }
    } else {
      for (const r of ecruRolls) {
        const ecruPoids = Number(r.poids)
        initial[r.IDstock_ecru] = {
          lot: '',
          // Format to 1 decimal — HFSQL stores poids as float and the
          // ODBC bridge surfaces values like 4.800000190734863. Match the
          // Tricobot autofill formatting so the field never shows the
          // floating-point tail.
          poids: ecruPoids > 0 ? ecruPoids.toFixed(1) : '',
          metrage: '',
          observations: '',
          observation_sst: '',
          split: false,
          poids2: '',
          metrage2: '',
        }
      }
    }
    return initial
  })

  // Wizard state: which roll is in the top editor, and which rolls have
  // been visited (drives sticky-lot carryover — we only pre-fill the lot
  // on a fresh roll, never on one the user already touched).
  const [currentIndex, setCurrentIndex] = useState(0)
  const [visited, setVisited] = useState<Set<number>>(() => {
    const first = rolls[0]?.id
    return first !== undefined ? new Set([first]) : new Set()
  })

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [doneCount, setDoneCount] = useState(0)

  // Direct ref into the métrage input so the "Suivant" button can punt focus
  // straight there — the operator's hands then stay on the keyboard for the
  // dominant case (type lot → tab → type metrage → click Suivant → type
  // next metrage → …).
  const metrageInputRef = useRef<HTMLInputElement | null>(null)
  const focusMetrageNextTick = () => {
    // queueMicrotask runs after React commits the rerender from setCurrentIndex
    // but before paint, so the new row's value is in the DOM by the time
    // .focus() + .select() fires.
    queueMicrotask(() => {
      const el = metrageInputRef.current
      if (!el) return
      el.focus()
      el.select()
    })
  }

  // Tricobot autofill state. `idle` → wave image, clickable.
  // `loading` → wave image, spinner overlay, disabled. `done` → thumb-up
  // image, locked. `tricobotMessage` is a short status line shown below
  // the title for either success ("N rouleaux remplis…") or failure.
  const [tricobotState, setTricobotState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [tricobotMessage, setTricobotMessage] = useState<string | null>(null)
  // Whether `tricobotMessage` is a failure/empty result — drives the red
  // text. A "found nothing" result still sets state='done' (the run did
  // complete), so the colour can't key off `tricobotState`.
  const [tricobotMsgError, setTricobotMsgError] = useState(false)

  const current = rolls[currentIndex]
  const currentRow = current ? rows[current.id] : null
  const canPrev = currentIndex > 0
  const canNext = currentIndex < rolls.length - 1

  // Fini-level preview: one entry per stock_fini row that will be created
  // (or PATCHed in reprise). A split roll expands into two entries —
  // `<base>-1` and `<base>-2` — so the bottom list shows the operator
  // exactly the rolls they'll receive (3 écru with one cut → 4 finis).
  // `wizardIndex` points back at the écru editor step the entry belongs to.
  type FiniPreview = {
    key: string
    wizardIndex: number
    ecruId: number
    numero: string
    lot: string
    poids: number
    metrage: number
    complete: boolean
    hasObs: boolean
    hasDef: boolean
    half: 0 | 1 | 2
  }
  const finiPreview: FiniPreview[] = []
  rolls.forEach((r, i) => {
    const row = rows[r.id]
    if (!row) return
    const lot = (row.lot ?? '').trim()
    const lotOk = lot.length > 0
    const hasObs = (row.observations ?? '').trim().length > 0
    const hasDef = (row.observation_sst ?? '').trim().length > 0
    const baseNum = r.numero || `#${r.id}`
    if (row.split) {
      const base = baseNum.slice(0, 18)
      finiPreview.push({
        key: `${r.id}-1`, wizardIndex: i, ecruId: r.id, numero: `${base}-1`,
        lot, poids: Number(row.poids) || 0, metrage: Number(row.metrage) || 0,
        complete: lotOk && Number(row.metrage) > 0, hasObs, hasDef, half: 1,
      })
      finiPreview.push({
        key: `${r.id}-2`, wizardIndex: i, ecruId: r.id, numero: `${base}-2`,
        lot, poids: Number(row.poids2) || 0, metrage: Number(row.metrage2) || 0,
        complete: lotOk && Number(row.metrage2) > 0, hasObs, hasDef, half: 2,
      })
    } else {
      finiPreview.push({
        key: `${r.id}`, wizardIndex: i, ecruId: r.id, numero: baseNum,
        lot, poids: Number(row.poids) || 0, metrage: Number(row.metrage) || 0,
        complete: lotOk && Number(row.metrage) > 0, hasObs, hasDef, half: 0,
      })
    }
  })
  // Every fini must have a non-empty lot AND a positive metrage before the
  // operator can submit. Without this guard the server happily accepts
  // stock_fini rows with metrage=0 / empty lot, which is invisible at the
  // create call but breaks downstream Soumission-Lot eligibility (the lot
  // key is the join column) and the suivilot insert.
  const finiCount = finiPreview.length
  const completeCount = finiPreview.reduce((n, e) => n + (e.complete ? 1 : 0), 0)
  const allRowsComplete = finiCount > 0 && completeCount === finiCount
  const totalMetrage = finiPreview.reduce((s, e) => s + e.metrage, 0)
  const canSubmit = idRefFini > 0 && rolls.length > 0 && !submitting && allRowsComplete

  const updateCurrent = (patch: Partial<BatchReceptionRow>) => {
    if (!current) return
    setRows((prev) => ({ ...prev, [current.id]: { ...prev[current.id], ...patch } }))
  }

  // Move to a different roll index. Sticky lot carryover: if the
  // destination roll has an empty lot, inherit the current roll's lot
  // value as a default. A roll that's been edited (its lot is non-empty)
  // never gets overridden — the user's typed value always wins.
  const goTo = (next: number) => {
    if (next < 0 || next >= rolls.length) return
    const target = rolls[next]
    if (current && target.id !== current.id) {
      setRows((prev) => {
        const carry = (prev[current.id]?.lot ?? '').trim()
        const targetLot = (prev[target.id]?.lot ?? '').trim()
        if (carry.length === 0 || targetLot.length > 0) return prev
        return {
          ...prev,
          [target.id]: { ...prev[target.id], lot: carry },
        }
      })
    }
    setVisited((prev) => {
      if (prev.has(target.id)) return prev
      const nextSet = new Set(prev)
      nextSet.add(target.id)
      return nextSet
    })
    setCurrentIndex(next)
  }

  // Tricobot autofill. Fetches rows from data_bl_tricotbot for this
  // ligne, matches each row to a wizard roll by `num_piece === numero`
  // (écru numero in create mode, fini numero in reprise — a reprise
  // sends the same physical rolls back to the sst, and the corrected
  // BL Tricobot parses lists those same piece numbers), and overwrites
  // that roll's lot/poids/metrage/defaut. Only non-empty BL values
  // overwrite: in reprise the fields are pre-filled from the existing
  // stock_fini row and a hole in the BL must not wipe them. The user's
  // blue Commentaire is left untouched (it's a manual note to the
  // customer, not on the BL).
  const handleTricobotClick = async () => {
    if (tricobotState !== 'idle') return
    setTricobotState('loading')
    setTricobotMessage(null)
    setTricobotMsgError(false)
    try {
      const data = await apiFetch<Array<{
        IDdata_bl_tricotbot: number
        lot: string | null
        poids: number | null
        metrage: number | null
        observation: string | null
        num_piece: string | null
      }>>(
        `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/tricobot`,
      )
      const byNumero = new Map<string, typeof data[number]>()
      for (const r of data) {
        const np = (r.num_piece ?? '').trim()
        if (np) byNumero.set(np, r)
      }
      // Count matches synchronously — the setRows updater below runs
      // lazily, so reading a `filled++` from inside it would still be 0
      // when we build the status message.
      const matches: Array<{ rollId: number; hit: typeof data[number] }> = []
      for (const r of rolls) {
        const np = (r.numero ?? '').trim()
        const hit = np ? byNumero.get(np) : undefined
        if (hit) matches.push({ rollId: r.id, hit })
      }
      const filled = matches.length
      if (filled > 0) {
        setRows((prev) => {
          const next = { ...prev }
          for (const { rollId, hit } of matches) {
            const poidsNum = Number(hit.poids)
            const metrageNum = Number(hit.metrage)
            const lotVal = (hit.lot ?? '').trim()
            const obsVal = (hit.observation ?? '').trim()
            next[rollId] = {
              ...next[rollId],
              lot: lotVal || next[rollId].lot,
              poids: poidsNum > 0 ? poidsNum.toFixed(1) : next[rollId].poids,
              metrage: metrageNum > 0 ? metrageNum.toFixed(1) : next[rollId].metrage,
              observation_sst: obsVal || next[rollId].observation_sst,
            }
          }
          return next
        })
      }
      setTricobotState('done')
      const missing = rolls.length - filled
      setTricobotMsgError(filled === 0)
      setTricobotMessage(
        filled === 0
          ? `Tricobot n'a trouvé aucun rouleau correspondant dans la base.`
          : missing === 0
            ? `Tricobot a trouvé les ${filled} rouleaux 🎉`
            : `Tricobot a trouvé ${filled} rouleau${filled > 1 ? 'x' : ''} sur ${rolls.length} · ${missing} restant${missing > 1 ? 's' : ''} à compléter manuellement`,
      )
    } catch (err) {
      setTricobotState('idle')
      setTricobotMsgError(true)
      setTricobotMessage(err instanceof Error ? err.message : 'Erreur Tricobot')
    }
  }

  const handleSubmit = async () => {
    setError(null)
    setSubmitting(true)
    setDoneCount(0)
    let lastPayload: PiecesPayload | null = null
    const num = (v: string) => {
      const x = Number(v)
      return isNaN(x) ? 0 : x
    }
    try {
      if (isReprise) {
        // Reprise: PATCH each fini roll with the edited values. The
        // server resets IDetat_stock_fini back to 1 (En contrôle) so the
        // visiteur can re-validate after the correction.
        //
        // Split ("Couper en deux"): the sst sometimes returns a reprise
        // roll cut into two physical pieces. The existing row becomes
        // piece 1 (renamed `<base>-1`) via the same PATCH; piece 2 POSTs
        // as a new stock_fini row (`<base>-2`) carrying the original's
        // source écru plus explicit coloris/magasin overrides so both
        // halves stay identical apart from poids/metrage.
        for (const r of finiRolls) {
          const row = rows[r.IDstock_fini]
          const base = (r.numero || `#${r.IDstock_fini}`).slice(0, 18)
          const payload = await apiFetch<PiecesPayload>(
            `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/fini/${r.IDstock_fini}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(row.split ? { numero: `${base}-1` } : {}),
                lot: row.lot,
                poids: num(row.poids),
                metrage: num(row.metrage),
                observations: row.observations,
                observation_sst: row.observation_sst,
                // Reset to En contrôle for re-validation.
                IDetat_stock_fini: 1,
              }),
            },
          )
          lastPayload = payload
          setDoneCount((n) => n + 1)
          if (row.split) {
            lastPayload = await apiFetch<PiecesPayload>(
              `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/fini`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  numero: `${base}-2`,
                  lot: row.lot,
                  poids: num(row.poids2),
                  metrage: num(row.metrage2),
                  IDstock_ecru: r.IDstock_ecru || 0,
                  IDref_fini: r.IDref_fini || idRefFini,
                  IDColoris: r.IDColoris || 0,
                  IDmagasin: r.IDmagasin || 0,
                  observations: row.observations,
                  observation_sst: row.observation_sst,
                }),
              },
            )
            setDoneCount((n) => n + 1)
          }
        }
      } else {
        const postFini = async (body: Record<string, unknown>) =>
          apiFetch<PiecesPayload>(
            `/commandes-sous-traitant/${commandeId}/lignes/${ligne.IDligne_commande_sous_traitant}/pieces/fini`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          )
        for (const r of ecruRolls) {
          const row = rows[r.IDstock_ecru]
          const shared = {
            lot: row.lot,
            IDstock_ecru: r.IDstock_ecru,
            IDref_fini: idRefFini,
            IDmagasin: idMagasin || 0,
            observations: row.observations,
            observation_sst: row.observation_sst,
          }
          if (row.split) {
            // Couper en deux: one écru → two fini rolls `<base>-1` /
            // `<base>-2`, both pointing at the same source écru. Base is
            // trimmed to 18 so the suffix fits the 20-char numero column.
            const base = (r.numero || `#${r.IDstock_ecru}`).slice(0, 18)
            lastPayload = await postFini({
              ...shared, numero: `${base}-1`,
              poids: num(row.poids), metrage: num(row.metrage),
            })
            setDoneCount((n) => n + 1)
            lastPayload = await postFini({
              ...shared, numero: `${base}-2`,
              poids: num(row.poids2), metrage: num(row.metrage2),
            })
            setDoneCount((n) => n + 1)
          } else {
            lastPayload = await postFini({
              ...shared,
              numero: (r.numero || `#${r.IDstock_ecru}`).slice(0, 20),
              poids: num(row.poids), metrage: num(row.metrage),
            })
            setDoneCount((n) => n + 1)
          }
        }
      }
      if (lastPayload) onSuccess(lastPayload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur')
    } finally {
      setSubmitting(false)
    }
  }

  if (!current || !currentRow) return null

  // Base numero for the current roll's two halves when split. Trimmed to
  // 18 chars so `<base>-2` fits the 20-char stock_fini.numero column.
  const splitBase = (current.numero || `#${current.id}`).slice(0, 18)

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-3xl w-[92vw] h-[88vh] flex flex-col p-0 overflow-hidden" onClose={submitting ? undefined : onClose}>
        {/* Header — gold gradient, matches §32 SendEmailDialog look.
            Tricobot sits in the top right; clicking him pre-fills every
            roll from `data_bl_tricotbot`. */}
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <FiniRollIcon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">
              {isReprise
                ? `Reprendre ${finiCount} rouleau${finiCount > 1 ? 'x' : ''}`
                : `Réceptionner ${finiCount} rouleau${finiCount > 1 ? 'x' : ''}`}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              Tombé métier {currentIndex + 1} sur {rolls.length}
            </p>
            {!!tricobotMessage && (
              <p
                className={cn(
                  'text-[11px] mt-1 leading-snug',
                  tricobotMsgError ? 'text-destructive' : 'text-green-700',
                )}
              >
                {tricobotMessage}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleTricobotClick}
            disabled={tricobotState !== 'idle'}
            title={tricobotState === 'done'
              ? 'Données importées par Tricobot'
              : 'Remplir automatiquement avec Tricobot'}
            className={cn(
              // mr-8 keeps Tricobot clear of the dialog's top-right close X.
              // rounded-md keeps the corner curve tight enough that the
              // bot's outstretched arms don't get visibly clipped, so we
              // can drop the inner padding and let him fill the frame.
              'group relative h-20 w-20 flex-shrink-0 mr-8 rounded-md border-2 border-transparent bg-white/40 backdrop-blur-sm transition-all p-0.5',
              tricobotState === 'idle' && 'cursor-pointer hover:border-gold hover:bg-white hover:shadow-md hover:scale-105',
              tricobotState === 'loading' && 'cursor-wait opacity-80',
              tricobotState === 'done' && 'border-green-500/60 bg-green-50/60 cursor-default',
            )}
          >
            <img
              src={tricobotState === 'done' ? '/tricobot/tricobot-thumbs.jpeg' : '/tricobot/tricobot-wave.png'}
              alt="Tricobot"
              className="h-full w-full object-contain"
              draggable={false}
            />
            {tricobotState === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/50 rounded-lg">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            )}
            {tricobotState === 'idle' && (
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 translate-y-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-primary bg-white shadow-sm border border-gold/40 rounded px-2 py-0.5">
                Tricobot
              </span>
            )}
          </button>
        </div>

        {/* Batch fields */}
        {/* Editor card for the current roll. Référence fini + Magasin are
            no longer surfaced as user inputs — `idRefFini` defaults to
            `ligne.IDreference` (the line's target ref) and `idMagasin`
            stays 0; both apply implicitly to every reception in the batch. */}
        <div className="flex-shrink-0 px-6 pt-4">
          <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-accent/[0.03] p-3 space-y-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-7 w-7 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
                <TmRollIcon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate">
                    {current.numero || `#${current.id}`}
                  </span>
                  {current.lot && (
                    <span className="text-[11px] text-muted-foreground truncate">
                      · lot {isReprise ? 'actuel' : 'écru'} {current.lot}
                    </span>
                  )}
                </div>
                {current.poidsRef != null && current.poidsRef > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                    {isReprise ? 'Poids actuel' : 'Poids écru'}: {fmtNum(current.poidsRef, 1)} kg
                  </p>
                )}
              </div>
            </div>

            {/* Lot (shared across both halves when split) + the
                couper-en-deux toggle — available in both modes. Create
                mode splits the écru into two POSTed fini rows; reprise
                mode splits the existing fini row (PATCH piece 1 + POST
                piece 2 — see handleSubmit). */}
            <div className="flex items-end gap-3">
              <div className="flex-1 min-w-0">
                <LabeledInput
                  label="Lot"
                  value={currentRow.lot}
                  onChange={(v) => updateCurrent({ lot: v })}
                  autoFocus
                />
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={currentRow.split}
                onClick={() => updateCurrent({ split: !currentRow.split })}
                title="Le rouleau a été coupé en deux par l'ennoblisseur"
                className={cn(
                  'flex items-center gap-2 h-8 flex-shrink-0 rounded-md border px-2.5 text-xs font-medium transition-colors',
                  currentRow.split
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border/60 bg-white text-muted-foreground hover:border-accent/40',
                )}
              >
                <Scissors className="h-3.5 w-3.5" />
                Couper en deux
                <span
                  className={cn(
                    'relative inline-flex h-4 w-7 items-center rounded-full transition-colors',
                    currentRow.split ? 'bg-accent shadow-inner' : 'bg-zinc-300',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ease-out',
                      currentRow.split ? 'translate-x-[14px]' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </div>

            {currentRow.split ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border/60 bg-white p-2.5 space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
                    Rouleau 1 · {splitBase}-1
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <LabeledInput
                      label="Poids (kg)"
                      type="number"
                      value={currentRow.poids}
                      onChange={(v) => updateCurrent({ poids: v })}
                    />
                    <LabeledInput
                      label="Métrage (Ml)"
                      type="number"
                      value={currentRow.metrage}
                      onChange={(v) => updateCurrent({ metrage: v })}
                      inputRef={metrageInputRef}
                    />
                  </div>
                </div>
                <div className="rounded-md border border-border/60 bg-white p-2.5 space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
                    Rouleau 2 · {splitBase}-2
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <LabeledInput
                      label="Poids (kg)"
                      type="number"
                      value={currentRow.poids2}
                      onChange={(v) => updateCurrent({ poids2: v })}
                    />
                    <LabeledInput
                      label="Métrage (Ml)"
                      type="number"
                      value={currentRow.metrage2}
                      onChange={(v) => updateCurrent({ metrage2: v })}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="Poids (kg)"
                  type="number"
                  value={currentRow.poids}
                  onChange={(v) => updateCurrent({ poids: v })}
                />
                <LabeledInput
                  label="Métrage (Ml)"
                  type="number"
                  value={currentRow.metrage}
                  onChange={(v) => updateCurrent({ metrage: v })}
                  inputRef={metrageInputRef}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-blue-700 flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" />
                  Commentaire (visible par le client)
                </label>
                <textarea
                  value={currentRow.observations}
                  onChange={(e) => updateCurrent({ observations: e.target.value })}
                  rows={2}
                  className="w-full rounded-md border border-blue-300 bg-white ring-1 ring-blue-100 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-red-700 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Défaut signalé par l'ennoblisseur
                </label>
                <textarea
                  value={currentRow.observation_sst}
                  onChange={(e) => updateCurrent({ observation_sst: e.target.value })}
                  rows={2}
                  className="w-full rounded-md border border-red-300 bg-white ring-1 ring-red-100 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { goTo(currentIndex - 1); focusMetrageNextTick() }}
                disabled={!canPrev}
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> Précédent
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { goTo(currentIndex + 1); focusMetrageNextTick() }}
                disabled={!canNext}
              >
                Suivant <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </div>

        {/* Bottom roll list — compact summary, click-to-jump */}
        <div className="flex-1 min-h-0 flex flex-col border-t mt-4 bg-zinc-100/80">
          <div className="flex-shrink-0 px-6 pt-3 pb-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Aperçu des {finiCount} rouleau{finiCount > 1 ? 'x' : ''} finis
            </p>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3 space-y-1 scrollbar-transparent">
            {finiPreview.map((e, idx) => {
              const isCurrent = e.wizardIndex === currentIndex
              const isVisited = visited.has(e.ecruId)
              const hasData =
                e.lot.length > 0 || e.metrage > 0 || e.hasObs || e.hasDef
              return (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => goTo(e.wizardIndex)}
                  className={cn(
                    'w-full rounded-md border bg-card p-2 text-left text-xs flex items-center gap-2 transition-colors',
                    isCurrent
                      ? 'border-accent ring-1 ring-accent shadow-[inset_3px_0_0_0_rgb(242_184_10)]'
                      : 'border-border/60 hover:border-accent/40'
                  )}
                >
                  <div className={cn(
                    'h-5 w-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-semibold tabular-nums',
                    isCurrent ? 'bg-accent text-accent-foreground'
                      : e.complete ? 'bg-accent/15 text-accent'
                      : isVisited ? 'bg-zinc-200 text-foreground'
                      : 'bg-zinc-100 text-muted-foreground'
                  )}>
                    {e.complete && !isCurrent ? <Check className="h-3 w-3" /> : idx + 1}
                  </div>
                  <span className="font-semibold truncate flex-shrink-0 max-w-[130px] flex items-center gap-1">
                    {e.half !== 0 && (
                      <Scissors className="h-3 w-3 text-accent flex-shrink-0" />
                    )}
                    {e.numero}
                  </span>
                  <div className="flex items-center gap-2 tabular-nums text-muted-foreground min-w-0 flex-1 truncate">
                    {e.lot && <span className="truncate">lot {e.lot}</span>}
                    {e.poids > 0 && <span>· {fmtNum(e.poids, 1)} kg</span>}
                    {e.metrage > 0 && <span>· {fmtNum(e.metrage, 1)} Ml</span>}
                    {!hasData && <span className="italic">— en attente</span>}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {e.hasObs && <MessageSquare className="h-3 w-3 text-blue-600" />}
                    {e.hasDef && <AlertTriangle className="h-3 w-3 text-red-600" />}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-start text-xs tabular-nums leading-tight">
              <span className="font-semibold">
                Total : {fmtNum(totalMetrage, 1)} Ml
              </span>
              <span className={cn(
                'text-[11px]',
                allRowsComplete ? 'text-muted-foreground' : 'text-amber-700',
              )}>
                {completeCount} / {finiCount} rouleau{finiCount > 1 ? 'x' : ''} complet{completeCount > 1 ? 's' : ''}
              </span>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={submitting}>Annuler</Button>
              <Button
                onClick={handleSubmit}
                disabled={!canSubmit}
                title={!allRowsComplete ? 'Chaque rouleau doit avoir un lot et un métrage' : undefined}
              >
                {submitting
                  ? `Enregistrement... (${doneCount}/${finiCount})`
                  : isReprise
                    ? `Reprendre ${finiCount} rouleau${finiCount > 1 ? 'x' : ''}`
                    : `Réceptionner ${finiCount} rouleau${finiCount > 1 ? 'x' : ''}`}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Picker dialog for the "+ Affecter" affordance on the Affectés section of
// the ennoblisseur PiecesDrawer. Lets the user multi-select compatible
// écru rolls from `ecruAvailable` and link them in one batch via
// `onBulkLink`. The parent's `linkEcruMut` is invoked once per id (small
// N — operators typically pick 1-5 rolls at a time).
function LinkEcruDialog({
  available, sousTraitantNom, onBulkLink, onClose,
}: {
  available: StockEcruLite[]
  /** Sst name appended to the subtitle ("disponibles chez MATEL"). The
   *  picker is scoped to rolls whose IDmagasin equals this sst's id, so
   *  surfacing the name avoids ambiguity ("64 disponibles … where?"). */
  sousTraitantNom: string | null | undefined
  onBulkLink: (ids: number[]) => Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Anchor for Shift+click range selection (same pattern as PiecesDrawer's
  // Affectés tab — lastSelectedEcruIdRef). Set on every plain click, kept
  // stable across Shift+clicks so the range always extends from the same
  // anchor (OS file-manager convention).
  const lastSelectedRef = useRef<number | null>(null)

  const totalKg = available
    .filter((r) => selected.has(r.IDstock_ecru))
    .reduce((s, r) => s + (Number(r.poids) || 0), 0)
  const allSelected = available.length > 0 && available.every((r) => selected.has(r.IDstock_ecru))

  const selectAll = () => {
    setSelected(new Set(available.map((r) => r.IDstock_ecru)))
    lastSelectedRef.current = available[available.length - 1]?.IDstock_ecru ?? null
  }
  const clearSelection = () => {
    setSelected(new Set())
    lastSelectedRef.current = null
  }

  const handleToggle = (id: number, shiftKey: boolean) => {
    const ids = available.map((r) => r.IDstock_ecru)
    const anchor = lastSelectedRef.current
    // Shift+click: extend the selection from the anchor to the clicked row.
    // The anchor stays put so successive Shift+clicks keep the range based
    // on the original starting point — matches OS file-manager behaviour.
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) next.add(ids[i])
          return next
        })
        return
      }
    }
    // Plain click — toggle and become the new anchor.
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    lastSelectedRef.current = id
  }

  const handleSubmit = async () => {
    setError(null)
    setBusy(true)
    try {
      await onBulkLink(Array.from(selected))
      onClose()
    } catch (e: any) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-2xl w-[92vw] h-[80vh] flex flex-col p-0 overflow-hidden" onClose={busy ? undefined : onClose}>
        <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b bg-gradient-to-r from-gold/25 via-gold/10 to-transparent flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg icon-box-gold flex items-center justify-center flex-shrink-0">
            <Link2 className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-heading font-bold tracking-tight truncate">
              Affecter des rouleaux écru
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {available.length} rouleau{available.length > 1 ? 'x' : ''} disponible{available.length > 1 ? 's' : ''}
              {sousTraitantNom && ` chez ${sousTraitantNom}`}
              {selected.size > 0 && ` · ${selected.size} sélectionné${selected.size > 1 ? 's' : ''} (${fmtNum(totalKg, 1)} kg)`}
            </p>
            <p className="text-[10px] text-muted-foreground/80 italic mt-0.5">
              Astuce : Maj+clic pour sélectionner une plage.
            </p>
          </div>
          {available.length > 0 && (
            // Same selection-toggle pattern as the Affectés tab inside the
            // ennoblisseur PiecesDrawer — two text links separated by a
            // mid-dot, each with its own disabled state. `mr-8` keeps the
            // links clear of the dialog's built-in top-right close X
            // (matches the Tricobot button positioning in BatchReceptionDialog).
            <div className="flex items-center gap-1 flex-shrink-0 mt-1 mr-8">
              <button
                type="button"
                onClick={selectAll}
                disabled={busy || allSelected}
                className="text-[11px] text-accent hover:underline disabled:text-muted-foreground/50 disabled:no-underline disabled:cursor-default px-1"
              >
                Tout sélectionner
              </button>
              <span className="text-muted-foreground/40 text-[11px]">·</span>
              <button
                type="button"
                onClick={clearSelection}
                disabled={busy || selected.size === 0}
                className="text-[11px] text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40 disabled:cursor-default px-1"
              >
                Aucun
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5 bg-zinc-100/80 scrollbar-transparent">
          {available.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <TmRollIcon className="h-12 w-12 mb-2 opacity-40" />
              <p className="text-sm">Aucun rouleau écru disponible pour cette référence</p>
            </div>
          ) : (
            available.map((roll) => (
              <SelectableEcruRow
                key={roll.IDstock_ecru}
                roll={roll}
                selected={selected.has(roll.IDstock_ecru)}
                onToggle={(shiftKey) => handleToggle(roll.IDstock_ecru, shiftKey)}
                disabled={busy}
              />
            ))
          )}
        </div>

        <div className="flex-shrink-0 px-6 py-3 border-t bg-zinc-200/50">
          {!!error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
            <Button onClick={handleSubmit} disabled={busy || selected.size === 0}>
              {busy ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Affectation…</>
              ) : (
                <><Link2 className="h-3.5 w-3.5 mr-1.5" />Affecter {selected.size > 0 ? `${selected.size} rouleau${selected.size > 1 ? 'x' : ''}` : ''}</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SelectableEcruRow({
  roll, selected, onToggle, disabled,
}: {
  roll: StockEcruLite
  selected: boolean
  /** Forward the click's shift modifier so the caller can implement
   *  range selection (OS file-manager Shift+click convention). */
  onToggle: (shiftKey: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(e) => onToggle(e.shiftKey)}
      disabled={disabled}
      className={cn(
        'w-full rounded-lg border bg-white p-3 flex items-center gap-3 text-left transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent bg-accent/[0.06]'
          : 'border-border/60 hover:border-accent/50 hover:bg-accent/[0.03]',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      <div className={cn(
        'h-5 w-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors',
        selected
          ? 'bg-accent border-accent text-accent-foreground'
          : 'bg-white border-input',
      )}>
        {selected && <Check className="h-3.5 w-3.5" />}
      </div>
      <div className="h-10 w-10 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
        <TmRollIcon className="h-7 w-7 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold truncate">
            {roll.numero || `#${roll.IDstock_ecru}`}
          </span>
          {roll.lot && (
            <span className="text-xs text-muted-foreground truncate">· lot {roll.lot}</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums">
          {Number(roll.poids) > 0 && (
            <span className="font-medium text-foreground">{fmtNum(Number(roll.poids), 1)} kg</span>
          )}
          {Number(roll.metrage) > 0 && (
            <span>{fmtNum(Number(roll.metrage), 1)} Ml</span>
          )}
          {roll.date_saisie && (
            <span>entré {formatHfsqlDate(roll.date_saisie)}</span>
          )}
        </div>
        <RollNotes
          secondChoix={Number(roll.second_choix) > 0}
          observations={[
            { label: null, text: roll.observations?.trim() ?? '' },
          ]}
          defects={roll.defects}
        />
      </div>
    </button>
  )
}

// ── Line form fields ──────────────────────────────────

function LineFormFields({
  form, setForm, kind, refsFini, refsEcru, editable, autoPricing,
}: {
  form: { IDreference: number; IDColoris: number; quantite: string; prix: string; date_livraison: string }
  setForm: (f: typeof form) => void
  /** Which catalog the line uses:
   *  - 'fini' → ref_fini + ref_fini_colori (ennoblisseur)
   *  - 'ecru' → ref_ecru + colori_ecru   (tricoteur — line spec is the
   *             output écru the knitter must produce, see
   *             [[project-sst-line-polymorphic]]) */
  kind: 'fini' | 'ecru'
  refsFini: RefFiniLookup[]
  refsEcru: RefEcruLookup[]
  editable: boolean
  /** When true, the Prix input is read-only (ennoblisseur auto-pricing).
   *  When false, the field is editable — tricoteur defaults the price from
   *  ref_ecru.prix on selection but the user can override. */
  autoPricing?: boolean
}) {
  const isEcru = kind === 'ecru'
  const prixDisabled = !isEcru && autoPricing !== false

  // Coloris options — different table per kind.
  const { data: coloriFiniOptions } = useQuery<Array<{ IDref_fini_colori: number; reference: string }>>({
    queryKey: ['commande-sst-colori-fini', form.IDreference],
    queryFn: () => apiFetch(`/commandes-sous-traitant/lookups/colori-fini?ref_fini=${form.IDreference}`),
    enabled: !isEcru && editable && form.IDreference > 0,
  })
  const { data: coloriEcruOptions } = useQuery<Array<{ IDcolori_ecru: number; reference: string }>>({
    queryKey: ['commande-sst-colori-ecru', form.IDreference],
    queryFn: () => apiFetch(`/commandes-sous-traitant/lookups/colori-ecru?ref_ecru=${form.IDreference}`),
    enabled: isEcru && editable && form.IDreference > 0,
  })

  const coloriOpts = isEcru
    ? (coloriEcruOptions ?? []).map((c) => ({ id: c.IDcolori_ecru, primary: c.reference }))
    : (coloriFiniOptions ?? []).map((c) => ({ id: c.IDref_fini_colori, primary: c.reference }))

  // When picking a ref_ecru, auto-fill prix from the catalog value so the
  // user sees the unit cost up front. They can still override before save.
  const handleEcruPick = (id: number) => {
    const ref = refsEcru.find((r) => r.IDref_ecru === id)
    const nextPrix = ref && ref.prix > 0 && (form.prix === '' || form.prix === '0') ? String(ref.prix) : form.prix
    setForm({ ...form, IDreference: id, IDColoris: 0, prix: nextPrix })
  }

  return (
    <>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {isEcru ? 'Référence écru' : 'Référence fini'}
        </label>
        {isEcru ? (
          <SearchableCombobox<RefEcruLookup>
            options={refsEcru}
            value={form.IDreference}
            onChange={handleEcruPick}
            getId={(r) => r.IDref_ecru}
            getPrimary={(r) => r.ref_ecru}
            getSecondary={(r) => r.designation || null}
            disabled={!editable}
            placeholder="Choisir une référence écru"
          />
        ) : (
          <SearchableCombobox<RefFiniLookup>
            options={refsFini}
            value={form.IDreference}
            onChange={(id) => setForm({ ...form, IDreference: id, IDColoris: 0 })}
            getId={(r) => r.IDref_fini}
            getPrimary={(r) => r.ref_fini}
            getSecondary={(r) => r.designation || null}
            disabled={!editable}
            placeholder="Choisir une référence fini"
          />
        )}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Coloris</label>
        <PopoverSelect
          options={coloriOpts}
          value={form.IDColoris}
          onChange={(id) => setForm({ ...form, IDColoris: id })}
          disabled={!editable || form.IDreference === 0}
          emptyLabel={form.IDreference === 0 ? '— Choisir une référence d\'abord —' : '— Aucun —'}
        />
        {!isEcru && (
          <p className="text-[10px] text-muted-foreground">
            Le tombé métier écru à envoyer est sélectionné dans le tiroir « pièces ».
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput
          label={isEcru ? 'Quantité (kg)' : 'Quantité (Ml)'}
          type="number"
          value={form.quantite}
          onChange={(v) => setForm({ ...form, quantite: v })}
        />
        {/* Prix is server-managed only for ennoblisseur lines with tariff
            data (`auto_pricing_enabled`). Tricoteur lines default the value
            from ref_ecru.prix but the field stays editable. */}
        <LabeledInput
          label="Prix (€/Kg)"
          type="number"
          value={form.prix}
          onChange={(v) => setForm({ ...form, prix: v })}
          disabled={prixDisabled}
          helper={prixDisabled ? 'Calculé automatiquement à partir des rouleaux affectés.' : undefined}
        />
      </div>
      <LabeledInput label="Date livraison" type="date" value={form.date_livraison} onChange={(v) => setForm({ ...form, date_livraison: v })} />
    </>
  )
}

// ── Right Panel: Sidebar with Tabs ─────────────────────

type SidebarTab = 'info' | 'adresses' | 'docs' | 'historique'

function DetailSidebar({
  commande, isLoading, isEditing,
  editDateCommande, onEditDateCommandeChange,
  editDateNotif, onEditDateNotifChange,
  editCommentaire, onEditCommentaireChange,
  editJournal, onEditJournalChange,
  editIDAdresseSousTraitant, onEditIDAdresseSousTraitantChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
  onToggleEtat, isTogglingEtat,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  isEditing: boolean
  editDateCommande: string
  onEditDateCommandeChange: (v: string) => void
  editDateNotif: string
  onEditDateNotifChange: (v: string) => void
  editCommentaire: string
  onEditCommentaireChange: (v: string) => void
  editJournal: string
  onEditJournalChange: (v: string) => void
  editIDAdresseSousTraitant: number
  onEditIDAdresseSousTraitantChange: (v: number) => void
  editIDAdresseLivraison: number
  onEditIDAdresseLivraisonChange: (v: number) => void
  onToggleEtat: () => void
  isTogglingEtat: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')

  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['commande-sst-adresses', commande?.IDsous_traitant],
    queryFn: () => apiFetch(`/commandes-sous-traitant/lookups/adresses?sous_traitant=${commande?.IDsous_traitant}`),
    enabled: isEditing && !!commande?.IDsous_traitant,
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

  // The Journal lives as a section *inside* the Info tab — no separate
  // tab. Keeps the sidebar three-tabbed and lets the user see commentaire
  // and journal entries side by side without flipping back and forth.
  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Info },
    { key: 'adresses', label: 'Adresses', icon: MapPin },
    { key: 'docs', label: 'Docs', icon: FileText },
    { key: 'historique', label: 'Historique', icon: Clock },
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
              editDateCommande={editDateCommande}
              onEditDateCommandeChange={onEditDateCommandeChange}
              editDateNotif={editDateNotif}
              onEditDateNotifChange={onEditDateNotifChange}
              editCommentaire={editCommentaire}
              onEditCommentaireChange={onEditCommentaireChange}
              editJournal={editJournal}
              onEditJournalChange={onEditJournalChange}
            />
          )}
          {activeTab === 'adresses' && (
            <AdressesTab
              commande={commande}
              isEditing={isEditing}
              adresses={adresses ?? []}
              editIDAdresseSousTraitant={editIDAdresseSousTraitant}
              onEditIDAdresseSousTraitantChange={onEditIDAdresseSousTraitantChange}
              editIDAdresseLivraison={editIDAdresseLivraison}
              onEditIDAdresseLivraisonChange={onEditIDAdresseLivraisonChange}
            />
          )}
          {activeTab === 'docs' && (
            <DocsTab commande={commande} isEditing={isEditing} />
          )}
          {activeTab === 'historique' && (
            <HistoriqueTab commandeId={commande.IDcommande_sous_traitant} />
          )}
        </div>
      </div>
      <StatusFooter
        phase={commande.phase}
        est_soldee={commande.est_soldee}
        onToggle={onToggleEtat}
        isToggling={isTogglingEtat}
        disabled={isEditing}
      />
    </div>
  )
}

// ── Sidebar Status Footer ──────────────────────────────

function StatusFooter({
  phase, est_soldee, onToggle, isToggling, disabled,
}: {
  /** Computed phase from the detail response. Drives the colored pill. */
  phase: SstPhase | null | undefined
  /** Still required: the Clôturer / Rouvrir button toggles est_soldee
   *  directly — it remains the only write gate. */
  est_soldee: number | null
  onToggle: () => void
  isToggling: boolean
  disabled: boolean
}) {
  const isTerminee = est_soldee === 1
  const meta = SST_PHASE_META[phase ?? 'en_cours']
  const Icon = meta.icon
  const actionLabel = isTerminee ? 'Rouvrir' : 'Clôturer'
  const ActionIcon = isTerminee ? Clock : CheckCircle2

  // Footer chrome: solid band coloured by the computed phase. Phase →
  // colour: en_cours=primary blue, en_controle=amber, soumis=violet,
  // en_reprise=orange, terminée=success green. White text on top.
  return (
    <div
      className={cn(
        'flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
        meta.solid,
      )}
    >
      <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
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

// ── TRM mirror card ────────────────────────────────────
// Shown in the Info tab when the sst targets Tricotage Malterre (the sister
// knitter). Status-only — Soldée / En cours derived from the mirrored
// `commande_client.est_soldee` (server gates on IDsous_traitant=1).
function TrmMirrorCard({ mirror }: { mirror: TrmMirror }) {
  const soldée = mirror.est_soldee === 1
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Factory className="h-3.5 w-3.5 text-accent" />Commande TRM
        </span>
        <Badge
          variant="outline"
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wide',
            soldée
              ? 'border-green-500/40 bg-green-50 text-green-700'
              : 'border-primary/30 bg-primary/5 text-primary',
          )}
        >
          {soldée ? 'Soldée' : 'En cours'}
        </Badge>
      </div>
    </div>
  )
}

/**
 * Standing quality instructions that apply to this order's lines, owned by
 * Qualité › Actions. Purely derived — nothing is stored on the commande — so
 * the card is read-only here and renders nothing when there's no match.
 * The same endpoint feeds the MENTIONS QUALITÉ block on the bon de commande
 * PDF, so screen and print can't drift.
 */
function MentionsQualiteCard({ commandeId }: { commandeId: number }) {
  const { data } = useQuery<{
    texts: string[]
    lignes: Array<{
      IDligne_commande_sous_traitant: number
      mentions: Array<{
        IDmention_qualite: number
        IDaction_qualite: number
        action_titre: string
        mention: string
      }>
    }>
  }>({
    queryKey: ['commande-sst-mentions-qualite', commandeId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/mentions-qualite`),
    enabled: commandeId > 0,
  })

  // Dedupe to the order level: several lines routinely match the same mention
  // and repeating it would just be noise.
  const rows = useMemo(() => {
    const seen = new Set<number>()
    const out: Array<{ id: number; action_titre: string; mention: string }> = []
    for (const l of data?.lignes ?? []) {
      for (const m of l.mentions) {
        if (seen.has(m.IDmention_qualite)) continue
        seen.add(m.IDmention_qualite)
        out.push({ id: m.IDmention_qualite, action_titre: m.action_titre, mention: m.mention })
      }
    }
    return out
  }, [data])

  if (rows.length === 0) return null

  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm border-l-4 border-l-red-500/60">
      <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
        Mentions qualité
      </p>
      <p className="text-[10px] text-muted-foreground mb-2 italic">
        Ajoutées automatiquement au bon de commande. Se modifient dans Qualité › Actions.
      </p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-md bg-red-50 border border-red-200 p-2">
            {!!r.action_titre.trim() && (
              <p className="text-[10px] font-semibold text-red-800 uppercase tracking-wide">
                {r.action_titre.trim()}
              </p>
            )}
            <p className="text-xs text-foreground whitespace-pre-line mt-0.5">{r.mention.trim()}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function InfoTab({
  commande, isEditing,
  editDateCommande, onEditDateCommandeChange,
  editDateNotif, onEditDateNotifChange,
  editCommentaire, onEditCommentaireChange,
  editJournal, onEditJournalChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  editDateCommande: string
  onEditDateCommandeChange: (v: string) => void
  editDateNotif: string
  onEditDateNotifChange: (v: string) => void
  editCommentaire: string
  onEditCommentaireChange: (v: string) => void
  editJournal: string
  onEditJournalChange: (v: string) => void
}) {
  return (
    <div className="space-y-3">
      {/* Relance — its own container at the top of the tab. The relance
          date is an actionable self-reminder, so it gets a distinct card
          + gold bell icon instead of sitting among the read-only meta. */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <BellRing className="h-3.5 w-3.5 text-accent" />Relance
          </span>
          {isEditing ? (
            <input
              type="date"
              value={editDateNotif}
              onChange={(e) => onEditDateNotifChange(e.target.value)}
              className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
            />
          ) : (
            <span className="text-sm">
              {commande.date_notif ? formatHfsqlDate(commande.date_notif) : '—'}
            </span>
          )}
        </div>
      </div>

      {/* TRM mirror — visible only when the sst targets Tricotage Malterre.
          Surfaces the sister-company commande_client's status + produced
          rolls without leaving the sst screen. */}
      {!!commande.trm_mirror && <TrmMirrorCard mirror={commande.trm_mirror} />}

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
        <KV label="Sous-traitant" value={commande.sous_traitant_nom || '—'} />
        <KV label="Type" value={commande.sous_traitant_type ?? '—'} />
        {commande.sous_traitant_tel && (
          <KV label="Téléphone" value={commande.sous_traitant_tel} />
        )}
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
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Commentaire
        </p>
        {isEditing ? (
          <textarea
            value={editCommentaire}
            onChange={(e) => onEditCommentaireChange(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : commande.commentaire?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{commande.commentaire.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
        )}
      </div>

      {/* Mentions qualité — read-only, derived from Qualité › Actions. Sits
          right under the commentaire because both answer "what does the sst
          get told?", but stays a separate card: the commentaire is this
          order's one-off note, these are standing quality instructions that
          also print on the bon de commande. */}
      <MentionsQualiteCard commandeId={commande.IDcommande_sous_traitant} />

      {/* Journal — moved here from its own tab. Same content as the legacy
          `JournalTab` rendered inline so commentaire and journal sit side
          by side in one scroll. */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5" />Journal
        </p>
        {isEditing ? (
          <textarea
            value={editJournal}
            onChange={(e) => onEditJournalChange(e.target.value)}
            rows={12}
            placeholder="Entrées de journal..."
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
          />
        ) : commande.journal?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line font-mono">{commande.journal.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucune entrée de journal</p>
        )}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({
  commande, isEditing, adresses,
  editIDAdresseSousTraitant, onEditIDAdresseSousTraitantChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  adresses: AdresseLookup[]
  editIDAdresseSousTraitant: number
  onEditIDAdresseSousTraitantChange: (v: number) => void
  editIDAdresseLivraison: number
  onEditIDAdresseLivraisonChange: (v: number) => void
}) {
  return (
    <div className="space-y-3">
      <AdresseCard
        label="Sous-traitant"
        adresse={commande.adresse_sous_traitant}
        isEditing={isEditing}
        options={adresses}
        selectedId={editIDAdresseSousTraitant}
        onSelect={onEditIDAdresseSousTraitantChange}
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
            Choisir une adresse {label.toLowerCase()}
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
}

interface TypeDoc {
  IDtype_doc: number
  nom: string
}

// ── Historique tab ─────────────────────────────────────
// Activity timeline for the commande. Sourced from the legacy
// `envoi_email` audit table — every email the company sends about a
// commande gets a row there (one per recipient). The API groups rows
// from the same send into one event so the timeline shows one entry
// per real action (bon de commande sent, soumission lot sent, etc.).

type HistoriqueEvent =
  | {
      kind: 'email'
      id: string
      date: string                   // "YYYY-MM-DD HH:MM:SS"
      type_doc_id: number
      type_doc_label: string
      recipients: Array<{ email: string; societe: string | null }>
      notes: string | null
    }
  | {
      kind: 'reponse'
      id: string
      date: string                   // "YYYY-MM-DD"
      reponse: number                // 1 = approuvé, 0 = refusé
      lot: string
      IDclient: number
    }

interface HistoriqueResponse {
  events: HistoriqueEvent[]
}

// Icon + label per type_doc for email events. Type 14 (avis expédition)
// is NOT in the server scope today (its IDreference points to
// `expedition`, not `commande_sous_traitant`) — kept here for a future
// wiring that walks sst lines → stock_fini → expedition.
const HISTORIQUE_EMAIL_META: Record<number, {
  label: string
  icon: typeof Clock
  accent: string
}> = {
  13: { label: 'Bon de commande envoyé',    icon: AtSign, accent: 'text-blue-700 bg-blue-500/10 border-blue-500/30' },
  14: { label: 'Avis d’expédition envoyé',  icon: Truck,  accent: 'text-cyan-700 bg-cyan-500/10 border-cyan-500/30' },
  15: { label: 'Soumission au client',      icon: Send,   accent: 'text-violet-700 bg-violet-500/10 border-violet-500/30' },
}

function HistoriqueTab({ commandeId }: { commandeId: number }) {
  const { data, isLoading, error } = useQuery<HistoriqueResponse>({
    queryKey: ['commande-sst-historique', commandeId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/historique`),
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-destructive">
        <AlertCircle className="h-6 w-6 mb-2" />
        <p className="text-sm">Erreur de chargement de l’historique</p>
      </div>
    )
  }
  const events = data?.events ?? []
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-2 py-6 text-center">
        Aucune activité pour le moment.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {events.map((evt) => evt.kind === 'email'
        ? <EmailEventCard key={evt.id} evt={evt} />
        : <ReponseEventCard key={evt.id} evt={evt} />
      )}
    </div>
  )
}

function EmailEventCard({ evt }: { evt: Extract<HistoriqueEvent, { kind: 'email' }> }) {
  const meta = HISTORIQUE_EMAIL_META[evt.type_doc_id]
    ?? { label: evt.type_doc_label || `type_doc ${evt.type_doc_id}`, icon: Clock, accent: 'text-muted-foreground bg-muted border-border' }
  const Icon = meta.icon
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
      <div className="flex items-start gap-2">
        <div className={cn('h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 border', meta.accent)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold truncate">{meta.label}</p>
            <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
              {formatHistoriqueDate(evt.date)}
            </span>
          </div>
          {evt.notes && (
            <span className={cn(
              'inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded border text-[11px] font-medium',
              meta.accent,
            )}>
              <Package className="h-3 w-3 flex-shrink-0" />
              Lot {evt.notes}
            </span>
          )}
          {evt.recipients.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1.5 break-all">
              {evt.recipients.map((r) => r.email).join(', ')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ReponseEventCard({ evt }: { evt: Extract<HistoriqueEvent, { kind: 'reponse' }> }) {
  // reponse: 1 = approuvé (green check), 0 = refusé (red X).
  const approved = evt.reponse === 1
  const meta = approved
    ? { label: 'Lot approuvé par le client',  Icon: CheckCircle2, accent: 'text-green-700 bg-green-500/10 border-green-500/30' }
    : { label: 'Lot refusé par le client',    Icon: X,            accent: 'text-red-700 bg-red-500/10 border-red-500/30' }
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
      <div className="flex items-start gap-2">
        <div className={cn('h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0 border', meta.accent)}>
          <meta.Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold truncate">{meta.label}</p>
            <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
              {formatHistoriqueDate(evt.date)}
            </span>
          </div>
          {evt.lot && (
            <span className={cn(
              'inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded border text-[11px] font-medium',
              meta.accent,
            )}>
              <Package className="h-3 w-3 flex-shrink-0" />
              Lot {evt.lot}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** "2026-03-09 14:17:36" → "09/03/2026 · 14:17"
 *  "2025-04-16"          → "16/04/2025"          (date-only — used by reponse_soumission). */
function formatHistoriqueDate(raw: string): string {
  if (!raw) return '—'
  const withTime = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (withTime) return `${withTime[3]}/${withTime[2]}/${withTime[1]} · ${withTime[4]}:${withTime[5]}`
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`
  return raw
}

function DocsTab({ commande, isEditing }: { commande: CommandeDetail; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const commandeId = commande.IDcommande_sous_traitant
  const docsQueryKey = ['commande-sst-docs', commandeId] as const

  const { data, isLoading, error } = useQuery<GedDocument[]>({
    queryKey: docsQueryKey,
    queryFn: () => apiFetch(`/commandes-sous-traitant/${commandeId}/documents`),
  })

  const [viewDoc, setViewDoc] = useState<GedDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<GedDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<GedDocument | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: docsQueryKey })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, commandeId])

  const deleteMut = useMutation({
    mutationFn: (idged: number) =>
      apiFetch(`/commandes-sous-traitant/${commandeId}/documents/${idged}`, { method: 'DELETE' }),
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
            Bons de retour ennoblisseur, soumissions, factures et autres documents apparaîtront ici.
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
                  {isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={(e) => { e.stopPropagation(); setDeleteDocConfirm(doc) }}
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
        description={deleteDocConfirm ? `« ${deleteDocConfirm.nom?.trim() || `Document #${deleteDocConfirm.IDged}`} » sera supprimé définitivement.` : undefined}
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
  const [idTypeDoc, setIdTypeDoc] = useState<number>(0)
  const [commentaire, setCommentaire] = useState('')
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: typeDocs } = useQuery<TypeDoc[]>({
    queryKey: ['commande-sst-types-doc'],
    queryFn: () => apiFetch('/commandes-sous-traitant/lookups/type-doc'),
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
        ? `${API_URL}/commandes-sous-traitant/${commandeId}/documents`
        : `${API_URL}/commandes-sous-traitant/${commandeId}/documents/${doc!.IDged}`
      const method = isNew ? 'POST' : 'PUT'
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

  const previewUrl = newFileUrl
    ? newFileUrl
    : !isNew && !removeFichier && doc
      ? `${API_URL}/commandes-sous-traitant/${commandeId}/documents/${doc.IDged}/fichier#view=FitH`
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
            {!!error && (
              <div className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
          </div>
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
                  /* No `accept` filter — documents can be any file type; lets the
                   * Windows picker show all files by default. */
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
    fetch(`${API_URL}/commandes-sous-traitant/${commandeId}/documents/${doc.IDged}/fichier`, {
      method: 'HEAD',
      credentials: 'include',
    })
      .then((r) => setFichierOk(r.ok))
      .catch(() => setFichierOk(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.IDged, commandeId])

  if (!doc) return null

  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe
            src={`${API_URL}/commandes-sous-traitant/${commandeId}/documents/${doc.IDged}/fichier#view=FitH`}
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

// ── Create Dialog (filtered to Ennoblisseur) ───────────

function CreateCommandeDialog({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (newId: number) => void
}) {
  // Phase 1: typeSst is locked to "Ennoblisseur" — kept as state so the
  // field is visible (and ready to expand to Tricoteur / Confectionneur in
  // Phase 2 by simply enabling the other options).
  const [typeSst, setTypeSst] = useState<string>(TYPE_ENNOBLISSEUR)
  const [sousTraitantId, setSousTraitantId] = useState<number>(0)
  const [dateCommande, setDateCommande] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [adresseStId, setAdresseStId] = useState<number>(0)
  const [adresseLivId, setAdresseLivId] = useState<number>(0)
  const [commentaire, setCommentaire] = useState('')

  // Sous-traitants list filtered by the picked type.
  const { data: sousTraitants } = useQuery<SousTraitantLite[]>({
    queryKey: ['create-cmd-sst-sous-traitants', typeSst],
    queryFn: () => apiFetch(`/commandes-sous-traitant/lookups/sous-traitants?type=${typeSst.toLowerCase()}`),
    enabled: open && !!typeSst,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['create-cmd-sst-adresses', sousTraitantId],
    queryFn: () => apiFetch(`/commandes-sous-traitant/lookups/adresses?sous_traitant=${sousTraitantId}`),
    enabled: open && sousTraitantId > 0,
  })

  useEffect(() => {
    if (!adresses) return
    const defaultSt = adresses.find((a) => a.est_defaut) ?? adresses[0]
    const defaultLiv = adresses.find((a) => a.est_defaut_livraison) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    setAdresseStId(defaultSt?.IDadresse ?? 0)
    setAdresseLivId(defaultLiv?.IDadresse ?? 0)
  }, [adresses])

  useEffect(() => {
    if (!open) {
      setTypeSst(TYPE_ENNOBLISSEUR)
      setSousTraitantId(0)
      setDateCommande(new Date().toISOString().slice(0, 10))
      setAdresseStId(0)
      setAdresseLivId(0)
      setCommentaire('')
    }
  }, [open])

  // Switching the type clears the sous-traitant pick (the previous one
  // doesn't necessarily belong to the new type).
  useEffect(() => { setSousTraitantId(0) }, [typeSst])

  const createMut = useMutation({
    mutationFn: () => apiFetch('/commandes-sous-traitant', {
      method: 'POST',
      body: JSON.stringify({
        IDsous_traitant: sousTraitantId,
        date_commande: inputDateToHfsql(dateCommande),
        IDadresse_sous_traitant: adresseStId || 0,
        IDadresse_livraison: adresseLivId || 0,
        commentaire,
      }),
    }),
    onSuccess: (data: { IDcommande_sous_traitant: number }) => onCreated(data.IDcommande_sous_traitant),
  })

  const canSave = sousTraitantId > 0 && dateCommande.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-accent" />
            Nouvelle commande sous-traitant
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Type sous-traitant</label>
            <PopoverSelect
              options={TYPE_SST_OPTIONS_PHASE1}
              value={TYPE_SST_ID_BY_LABEL[typeSst] ?? TYPE_SST_ID_BY_LABEL.Ennoblisseur}
              onChange={(id) => setTypeSst(TYPE_SST_LABEL_BY_ID[id] ?? TYPE_ENNOBLISSEUR)}
              hideEmpty
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Sous-traitant</label>
            <PopoverSelect
              options={(sousTraitants ?? []).map((s) => ({
                id: s.IDsous_traitant,
                primary: s.nom ?? `#${s.IDsous_traitant}`,
              }))}
              value={sousTraitantId}
              onChange={setSousTraitantId}
              disabled={!typeSst}
              emptyLabel="— Choisir —"
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
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Adresse sous-traitant</label>
            <PopoverSelect
              options={(adresses ?? []).map(adresseOption)}
              value={adresseStId}
              onChange={setAdresseStId}
              disabled={!adresses?.length}
              // Once the sous-traitant has at least one address, force the
              // user to pick one — no "—" escape hatch.
              hideEmpty={(adresses?.length ?? 0) > 0}
              emptyLabel="—"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Adresse livraison</label>
            <PopoverSelect
              options={(adresses ?? []).map(adresseOption)}
              value={adresseLivId}
              onChange={setAdresseLivId}
              disabled={!adresses?.length}
              hideEmpty={(adresses?.length ?? 0) > 0}
              emptyLabel="—"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
            <textarea
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
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
  label, value, onChange, type = 'text', autoFocus, disabled, helper, inputRef,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
  /** When true the input becomes read-only and styled muted. Used by
   *  fields whose value is computed by the server (e.g. ennoblisseur prix
   *  driven by `recalcLignePrix`). */
  disabled?: boolean
  /** Optional secondary text rendered under a disabled input to explain
   *  why the field is locked. */
  helper?: string
  /** Optional ref to the underlying input element. Used by callers that
   *  need programmatic focus (e.g. BatchReceptionDialog's Suivant button
   *  jumps focus straight into the metrage field). */
  inputRef?: React.Ref<HTMLInputElement>
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        data-form-type="other"
        data-lpignore="true"
        disabled={disabled}
        className={cn(inputClass, disabled && 'bg-muted text-muted-foreground cursor-not-allowed')}
      />
      {disabled && helper && (
        <p className="text-[10px] text-muted-foreground italic">{helper}</p>
      )}
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
