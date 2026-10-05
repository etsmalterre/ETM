// Sous-traitants › Factures (LIVA #1255) — the dyers' invoices the agent
// « Factures Ennoblisseur » read and checked against ETM's tariff. Fiche
// layout, single-list center: left the invoices (« À traiter » / « En
// réclamation » / « Toutes », red liseré = an écart), center the invoice's
// lines — each « conforme » or « écart », the person's say on it — right the
// totals, the remarks and the footer that closes the invoice (Validée, or En
// réclamation until the dyer answers → Réclamation close).
//
// This is where the agent is SCORED (decision Vincent 2026-10-02 — never in
// Agents IA): confirming or contradicting each line's verdict is the score
// (apps/api/src/lib/agents/factures-sst/avis.ts). Nothing here edits what
// the dyer billed.

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  AtSign,
  History,
  ChevronDown,
  CheckCircle2,
  ChevronUp,
  CircleSlash,
  Clock,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  MessageSquareWarning,
  Pencil,
  Package,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  Truck,
  Tag,
  TrendingDown,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { TricobotCorrection, TricobotRetourDialog } from '@/components/tricobot/TricobotRetour'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { postEmail, type EmailDefaults } from '@/lib/email'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { apiFetch, API_URL } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────

type StatutFacture = 'conforme' | 'ecarts'
type Traitement = 'validee' | 'reclamee' | 'reclamation_close' | null
/** Two verdicts per lot line (decision Vincent 2026-10-02); « info » = no lot billed. */
type Verdict = 'conforme' | 'ecart' | 'info'
/** Why an écart: something is wrong, or the agent could not check it. */
type Nature = 'reel' | 'non_verifie'
type Genre = 'lot' | 'emballage' | 'transport' | 'remise' | 'autre'

interface Controle {
  code: string
  gravite: 'bloquant' | 'avertissement' | 'info'
  message: string
}

interface FactureRow {
  id: number
  idsous_traitant: number
  sous_traitant: string
  numero: string
  date_facture: string | null
  date_echeance: string | null
  total_ht: number | null
  total_ttc: number | null
  statut: StatutFacture
  ecart_montant: number | null
  cree_le: string
  traitement: Traitement
  traite_le: string | null
  traite_par_nom: string | null
  traite_commentaire: string | null
  cloture_le: string | null
  nb_lots: number
  nb_ecarts: number
}

interface LigneFacture {
  id: number
  ordre: number
  genre: Genre
  designation: string
  traitements: string
  qualite: string
  lot: string
  numero_commande: string
  quantite: number | null
  unite: string
  pieces: number | null
  prix_unitaire: number | null
  montant: number | null
  idligne_commande_sous_traitant: number
  idcommande_sous_traitant: number
  idsuivilot: number
  poids_etm: number | null
  pieces_etm: number | null
  prix_attendu: number | null
  ecart_montant: number | null
  verdict: Verdict
  nature: Nature | null
  /** ETM's reference and coloris of the sst order line it bills (detail only). */
  ref_etm?: string | null
  coloris_etm?: string | null
  controles: Controle[]
  /** What the person who checked the invoice decided — null until then. */
  verdict_final: 'conforme' | 'ecart' | null
  avis_note: 'reussite' | 'echec' | null
  avis_commentaire: string | null
  avis_par_nom: string | null
  avis_le: string | null
}

interface FactureDetail extends Omit<FactureRow, 'nb_lots' | 'nb_ecarts'> {
  controles: Controle[]
  cloture_par_nom: string | null
  cloture_commentaire: string | null
  pdf_nom: string | null
  a_pdf: boolean
  run_id: string | null
  lignes: LigneFacture[]
}

type Vue = 'a_traiter' | 'en_reclamation' | 'tout'

// ── Shared status vocabulary ───────────────────────────

/** What the left card, the header badge and the footer pill show for an invoice. */
type Etat = 'a_valider' | 'ecarts' | 'validee' | 'reclamee' | 'reclamation_close'

/** From the list row: the agent's statut while open, the person's once closed. */
function etatDe(f: Pick<FactureRow, 'statut' | 'traitement'>): Etat {
  if (f.traitement) return f.traitement
  return f.statut === 'conforme' ? 'a_valider' : 'ecarts'
}

const ETAT_META: Record<Etat, { label: string; icon: ComponentType<{ className?: string }>; solid: string }> = {
  ecarts: { label: 'Écarts à traiter', icon: AlertTriangle, solid: 'bg-destructive border-destructive' },
  a_valider: { label: 'À valider', icon: Clock, solid: 'bg-zinc-500 border-zinc-500' },
  validee: { label: 'Validée', icon: CheckCircle2, solid: 'bg-success border-success' },
  reclamee: { label: 'En réclamation', icon: Send, solid: 'bg-primary border-primary' },
  reclamation_close: { label: 'Réclamation close', icon: CheckCircle2, solid: 'bg-success border-success' },
}

const joursDepuis = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : 0)

const VERDICT_META: Record<Verdict, { label: string; border: string; iconBg: string; iconColor: string; badge: string }> = {
  ecart: { label: 'Écart', border: 'border-l-destructive/60', iconBg: 'bg-destructive/10', iconColor: 'text-destructive/80', badge: 'bg-destructive text-white border-destructive' },
  conforme: { label: 'Conforme', border: 'border-l-green-500/60', iconBg: 'bg-green-500/10', iconColor: 'text-green-600', badge: 'bg-green-500/10 text-green-700 border-green-500/25' },
  info: { label: '', border: 'border-l-border', iconBg: 'bg-muted', iconColor: 'text-muted-foreground', badge: '' },
}

const GENRE_ICON: Record<Genre, ComponentType<{ className?: string }>> = {
  lot: Tag,
  emballage: Package,
  transport: Truck,
  remise: TrendingDown,
  autre: Info,
}

/** What the agent said on a lot line (null on a line that bills no lot). */
const avisAgentDe = (v: Verdict): 'conforme' | 'ecart' | null => (v === 'info' ? null : v)
/** The line's verdict as it stands: the person's, else the agent's. */
const verdictFinalDe = (l: LigneFacture) => l.verdict_final ?? avisAgentDe(l.verdict)
/** « À traiter »: the lines in écart, and those a person turned around. */
const aVoir = (l: LigneFacture) => verdictFinalDe(l) === 'ecart' || (!!l.verdict_final && l.verdict_final !== avisAgentDe(l.verdict))

// ── Page ───────────────────────────────────────────────

export function SousTraitantsFactures() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  // Deep link ?facture=<id> (the dashboard Notifications widget): selected, whatever the view.
  const lienFacture = (() => {
    const n = parseInt(searchParams.get('facture') ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : null
  })()
  const [selectedId, setSelectedId] = useState<number | null>(lienFacture)
  const [vue, setVue] = useState<Vue>(lienFacture ? 'tout' : 'a_traiter')
  const [searchQuery, setSearchQuery] = useState('')
  const [ecartsOn, setEcartsOn] = useState(false)
  const [pdfOpen, setPdfOpen] = useState(false)

  useEffect(() => {
    if (searchParams.has('facture')) {
      const next = new URLSearchParams(searchParams)
      next.delete('facture')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const listQuery = useQuery({
    queryKey: ['factures-sst', vue],
    queryFn: () => apiFetch<{ rows: FactureRow[] }>(`/factures-sst?vue=${vue}`).then((r) => r.rows),
  })
  const detailQuery = useQuery({
    queryKey: ['facture-sst', selectedId],
    queryFn: () => apiFetch<FactureDetail>(`/factures-sst/${selectedId}`),
    enabled: selectedId !== null,
  })

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data])
  const nbEcarts = rows.filter((r) => etatDe(r) === 'ecarts').length
  // A pill hides at 0, so an armed filter must not survive an emptied bucket (§41).
  const ecartsActif = ecartsOn && nbEcarts > 0

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return rows.filter((r) => {
      const e = etatDe(r)
      if (ecartsActif && e !== 'ecarts') return false
      if (!q) return true
      return `${r.numero} ${r.sous_traitant}`.toLowerCase().includes(q)
    })
  }, [rows, searchQuery, ecartsActif])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.id,
    select: setSelectedId,
    // The deep-linked invoice may sit outside the current filter until the list settles.
    suspended: listQuery.isFetching,
  })

  const traiterMut = useMutation({
    mutationFn: (body: { traitement: Traitement; commentaire: string }) =>
      apiFetch(`/factures-sst/${selectedId}/traitement`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['factures-sst'] })
      queryClient.invalidateQueries({ queryKey: ['facture-sst', selectedId] })
      queryClient.invalidateQueries({ queryKey: ['facture-sst-historique', selectedId] })
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
    },
  })

  const clotureMut = useMutation({
    mutationFn: (commentaire: string) =>
      apiFetch(`/factures-sst/${selectedId}/reclamation`, { method: 'PUT', body: JSON.stringify({ commentaire }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['factures-sst'] })
      queryClient.invalidateQueries({ queryKey: ['facture-sst', selectedId] })
      queryClient.invalidateQueries({ queryKey: ['facture-sst-historique', selectedId] })
    },
  })
  const detail = detailQuery.data ?? null
  const rafraichir = () => {
    queryClient.invalidateQueries({ queryKey: ['factures-sst'] })
    queryClient.invalidateQueries({ queryKey: ['facture-sst', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['facture-sst-historique', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
  }

  return (
    <>
      <MasterDetailLayout
        list={
          <FactureList
            rows={filtered}
            total={rows.length}
            isLoading={listQuery.isLoading}
            error={listQuery.error as Error | null}
            selectedId={selectedId}
            onSelect={setSelectedId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            vue={vue}
            onVueChange={setVue}
            nbEcarts={nbEcarts}
            ecartsOn={ecartsActif}
            onToggleEcarts={() => setEcartsOn((v) => !v)}
          />
        }
        detailHeader={<DetailHeader facture={detail} isLoading={detailQuery.isLoading && selectedId !== null} onOpenPdf={() => setPdfOpen(true)} />}
        detail={<DetailMain facture={detail} isLoading={detailQuery.isLoading && selectedId !== null} hasSelection={selectedId !== null} onChanged={rafraichir} />}
        sidebar={
          selectedId !== null ? (
            <DetailSidebar
              facture={detail}
              isLoading={detailQuery.isLoading}
              onTraiter={(traitement, commentaire) => traiterMut.mutateAsync({ traitement, commentaire })}
              onClore={(commentaire) => clotureMut.mutateAsync(commentaire)}
              onChanged={rafraichir}
              isTraiting={traiterMut.isPending || clotureMut.isPending}
            />
          ) : null
        }
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => setSelectedId(null)}
      />
      <PdfDialog open={pdfOpen} facture={detail} onClose={() => setPdfOpen(false)} />
    </>
  )
}

// ── Left panel ─────────────────────────────────────────

function CounterPill({ count, on, onToggle, title, tone }: { count: number; on: boolean; onToggle: () => void; title: string; tone: 'red' | 'amber' }) {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={title}
      className={cn(
        'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
        tone === 'red'
          ? on ? 'bg-red-500 text-white border-red-500 shadow-sm' : 'bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20'
          : on ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
      )}
    >
      {count}
    </button>
  )
}

function FactureList({
  rows, total, isLoading, error, selectedId, onSelect, searchQuery, onSearchChange, vue, onVueChange,
  nbEcarts, ecartsOn, onToggleEcarts,
}: {
  rows: FactureRow[]; total: number; isLoading: boolean; error: Error | null
  selectedId: number | null; onSelect: (id: number) => void
  searchQuery: string; onSearchChange: (q: string) => void
  vue: Vue; onVueChange: (v: Vue) => void
  nbEcarts: number; ecartsOn: boolean; onToggleEcarts: () => void
}) {
  const VUES: Array<{ key: Vue; label: string }> = [
    { key: 'a_traiter', label: 'À traiter' },
    { key: 'en_reclamation', label: 'En réclamation' },
    { key: 'tout', label: 'Toutes' },
  ]
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="N° de facture, sous-traitant…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              autoComplete="off"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <CounterPill count={nbEcarts} on={ecartsOn} onToggle={onToggleEcarts} title="Factures avec un écart à traiter" tone="red" />
        </div>
        <div className="flex flex-wrap gap-1">
          {VUES.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onVueChange(v.key)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                vue === v.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">{error.message || 'Erreur'}</p></div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-center">
            <ReceiptText className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">{vue === 'a_traiter' ? 'Aucune facture à traiter' : vue === 'en_reclamation' ? 'Aucune réclamation en cours' : 'Aucune facture'}</p>
          </div>
        ) : (
          rows.map((r) => <FactureCard key={r.id} row={r} isSelected={selectedId === r.id} onClick={() => onSelect(r.id)} />)
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length === total ? `${total} facture${total !== 1 ? 's' : ''}` : `${rows.length} / ${total} factures`}</span>
      </div>
    </div>
  )
}

function FactureCard({ row, isSelected, onClick }: { row: FactureRow; isSelected: boolean; onClick: () => void }) {
  const etat = etatDe(row)
  const meta = ETAT_META[etat]
  const Icon = meta.icon
  // §41: neutral unless it needs attention — red = a gap, amber = not checkable.
  // §41: red = an écart to handle; a claim left 15 days without answer turns amber.
  const attention = etat === 'ecarts' ? 'red' : etat === 'reclamee' && joursDepuis(row.traite_le) >= 15 ? 'amber' : null
  return (
    <div
      onClick={onClick}
      className={cn(
        'p-3 border rounded-lg cursor-pointer transition-all bg-white',
        isSelected
          ? attention === 'red' ? 'border-red-500 ring-1 ring-red-500' : attention === 'amber' ? 'border-amber-500 ring-1 ring-amber-500' : 'border-zinc-400 ring-1 ring-zinc-400'
          : attention === 'red' ? 'border-border hover:border-red-500/50' : attention === 'amber' ? 'border-border hover:border-amber-500/50' : 'border-border hover:border-zinc-400/60',
        attention === 'red' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
        attention === 'amber' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ReceiptText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <p className="font-medium text-sm truncate">{row.numero}</p>
        </div>
        <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white flex-shrink-0', meta.solid)}>
          <Icon className="h-2.5 w-2.5" />{meta.label}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 text-xs text-muted-foreground">
        <span className="truncate">{row.sous_traitant}{row.date_facture ? ` · ${formatHfsqlDate(row.date_facture)}` : ''}</span>
        <span className="tabular-nums flex-shrink-0">{row.total_ht != null ? `${fmtNum(row.total_ht, 2)} €` : '—'}</span>
      </div>
      {etat === 'reclamee' && (
        <p className={cn('text-[11px] mt-1', attention === 'amber' ? 'text-amber-800' : 'text-muted-foreground')}>
          En réclamation depuis {joursDepuis(row.traite_le) === 0 ? 'aujourd’hui' : `${joursDepuis(row.traite_le)} j`}
        </p>
      )}
      {row.nb_ecarts > 0 && etat === 'ecarts' && (
        <p className="text-[11px] text-destructive mt-1">
          {row.nb_ecarts} écart{row.nb_ecarts > 1 ? 's' : ''}{(row.ecart_montant ?? 0) > 0 ? ` · ${fmtNum(row.ecart_montant, 2)} € facturés en trop` : ''}
        </p>
      )}
    </div>
  )
}

// ── Center: header ─────────────────────────────────────

function DetailHeader({ facture, isLoading, onOpenPdf }: { facture: FactureDetail | null; isLoading: boolean; onOpenPdf: () => void }) {
  if (!facture && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-lg flex items-center justify-center icon-box-gold">
          <ReceiptText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading || !facture ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">Facture {facture.numero}</h1>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                <Badge variant="secondary" className="text-xs">{facture.sous_traitant}</Badge>
                {facture.date_facture && <Badge variant="secondary" className="text-xs">du {formatHfsqlDate(facture.date_facture)}</Badge>}
                {facture.date_echeance && <Badge variant="outline" className="text-xs">échéance {formatHfsqlDate(facture.date_echeance)}</Badge>}
              </div>
            </>
          )}
        </div>
        {facture && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="icon" className="h-9 w-9" title="Voir la facture (PDF)" onClick={onOpenPdf} disabled={!facture.a_pdf}>
              <FileText className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="h-1 w-24 mt-3 rounded-full bg-gradient-to-r from-accent via-accent to-accent/30" />
    </div>
  )
}

// ── Center: lines ──────────────────────────────────────
// Each lot line carries the agent's verdict. While the invoice is open the
// verdict pill is the ONLY gesture (decision Vincent 2026-10-05): clicking it
// means Tricobot got the line wrong, and he steps in to ask why. Untouched
// lines are confirmed by closing the invoice (réussite).
// Rules + scores: apps/api/src/lib/agents/factures-sst/avis.ts.

type ActionLigne = 'conforme' | 'ecart' | 'corriger'

/** Tricobot's own words when a person contradicts what he claimed (a
 *  conforme line, or a gap): « I got it wrong — tell me why ». */
const PAROLE_TRICOBOT: Record<string, { titre: string; texte: string; placeholder: string }> = {
  'conforme>ecart': { titre: 'Je me suis trompé !', texte: 'J’ai dit que cette ligne était conforme. Ce n’est pas le cas ? Tu peux m’expliquer ce qui est faux (prix, poids, traitement facturé…) ?', placeholder: 'Ex. facturé en PAT/BNO alors que c’est un lavage simple' },
  'reel>conforme': { titre: 'Je me suis trompé !', texte: 'J’ai signalé un écart sur cette ligne. Ce n’en est pas un ? Tu peux m’expliquer pourquoi elle est correcte ?', placeholder: 'Ex. prix 2026 convenu avec Gilles, le tarif ETM n’est pas à jour' },
  'nv>conforme': { titre: 'Je n’ai pas pu vérifier cette ligne', texte: 'Elle est conforme ? Tu peux me dire comment tu l’as vérifiée ? Je m’en servirai la prochaine fois.', placeholder: 'Ex. prix vérifié sur la grille MATEL 2026 : 7,30 €/kg, conforme' },
  corriger: { titre: 'Je me suis trompé ?', texte: 'L’écart est bien là, mais je me suis trompé sur la cause ou le montant ? Tu peux me donner les bons ?', placeholder: 'Ex. c’est le poids qui est faux, pas le prix : 19,7 kg facturés en trop' },
}

function cleMessage(l: LigneFacture, action: ActionLigne): string {
  if (action === 'corriger') return 'corriger'
  if (l.verdict === 'ecart' && l.nature === 'non_verifie') return `nv>${action}`
  return l.verdict === 'ecart' ? `reel>${action}` : `conforme>${action}`
}

/** Mirror of the server rule (avis.ts decider): when a comment is required. */
function commentaireRequis(l: LigneFacture, action: ActionLigne): boolean {
  if (action === 'corriger') return true
  return action !== l.verdict
}

function DetailMain({ facture, isLoading, hasSelection, onChanged }: {
  facture: FactureDetail | null
  isLoading: boolean
  hasSelection: boolean
  onChanged: () => void
}) {
  const [decision, setDecision] = useState<{ ligne: LigneFacture; action: ActionLigne } | null>(null)
  const avisMut = useMutation({
    mutationFn: (v: { id: number; action: ActionLigne | null; commentaire: string }) =>
      apiFetch(`/factures-sst/lignes/${v.id}/avis`, { method: 'PUT', body: JSON.stringify({ action: v.action, commentaire: v.commentaire }) }),
    onSuccess: () => onChanged(),
  })

  if (!hasSelection) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <div className="icon-box-gold h-16 w-16 rounded-xl flex items-center justify-center mb-3"><ReceiptText className="h-7 w-7" /></div>
        <p className="text-sm">Sélectionnez une facture</p>
      </div>
    )
  }
  if (isLoading || !facture) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  }
  const ouverte = !facture.traitement
  // Sections, not tabs (decision Vincent 2026-10-02): a clean invoice must
  // never open on an empty screen, and its conforme lines stay in sight
  // before « Valider ». Order of urgency: écarts, conformes, other lines.
  const lots = facture.lignes.filter((l) => l.genre === 'lot' && l.verdict !== 'info')
  const aTraiter = lots.filter(aVoir)
  const conformes = lots.filter((l) => !aVoir(l))
  const autres = facture.lignes.filter((l) => l.genre !== 'lot' || l.verdict === 'info')
  const parole = decision ? PAROLE_TRICOBOT[cleMessage(decision.ligne, decision.action)] ?? null : null
  const decider = (ligne: LigneFacture, action: ActionLigne) => {
    // Confirming what the agent said needs no explanation: saved at once.
    if (!commentaireRequis(ligne, action)) avisMut.mutate({ id: ligne.id, action, commentaire: '' })
    else setDecision({ ligne, action })
  }
  const carte = (l: LigneFacture) => (
    <LigneCard
      key={l.id}
      ligne={l}
      ouverte={ouverte}
      isPending={avisMut.isPending && avisMut.variables?.id === l.id}
      onDecider={(action) => decider(l, action)}
      onAnnuler={() => avisMut.mutate({ id: l.id, action: null, commentaire: '' })}
    />
  )
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {avisMut.error && (
        <div className="flex-shrink-0 mb-2 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{(avisMut.error as Error).message}</div>
      )}
      <div className="flex-1 min-h-0 overflow-auto space-y-1.5 p-1 scrollbar-transparent">
        <TitreSection tone="red" titre="À traiter" n={aTraiter.length} />
        {aTraiter.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2.5 text-sm text-green-800">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            Aucun écart — toutes les lignes sont conformes.
          </div>
        ) : aTraiter.map(carte)}

        {conformes.length > 0 && (
          <>
            <TitreSection tone="green" titre="Conformes" n={conformes.length} />
            {conformes.map(carte)}
          </>
        )}

        {autres.length > 0 && (
          <>
            <TitreSection tone="muted" titre="Autres lignes" n={autres.length} note="Emballage, transport, remises" />
            {autres.map(carte)}
          </>
        )}
      </div>
      <TricobotRetourDialog
        open={!!parole}
        titre={parole?.titre}
        sujet={decision?.ligne.lot}
        texte={parole?.texte}
        placeholder={parole?.placeholder}
        isPending={avisMut.isPending}
        onClose={() => setDecision(null)}
        onConfirm={async (commentaire) => {
          if (!decision) return
          await avisMut.mutateAsync({ id: decision.ligne.id, action: decision.action, commentaire })
          setDecision(null)
        }}
      />
    </div>
  )
}

function TitreSection({ titre, n, tone, note }: { titre: string; n: number; tone: 'red' | 'green' | 'muted'; note?: string }) {
  return (
    <div className="flex items-center gap-2 pt-2 first:pt-0">
      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', tone === 'red' ? 'bg-destructive' : tone === 'green' ? 'bg-green-500' : 'bg-zinc-400')} />
      <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
        {titre} <span className="tabular-nums">({n})</span>
      </p>
      {note && <span className="ml-auto text-[11px] text-muted-foreground">{note}</span>}
    </div>
  )
}

// Tolerances mirror the agent's (apps/api/src/lib/agents/factures-sst/controle.ts):
// a figure is flagged only where the agent would see a gap.
const poidsKo = (l: LigneFacture) => l.quantite != null && l.poids_etm != null && Math.abs(l.quantite - l.poids_etm) > Math.max(0.5, 0.005 * l.poids_etm)
const piecesKo = (l: LigneFacture) => l.pieces != null && l.pieces_etm != null && l.pieces !== l.pieces_etm
const prixKo = (l: LigneFacture) => l.prix_unitaire != null && l.prix_attendu != null && l.prix_unitaire - l.prix_attendu > Math.max(0.02, 0.01 * l.prix_attendu)
/** What ETM expected to pay for the line: ETM weight × tariff, else the
 *  billed amount minus the overbilling the agent measured. */
function montantAttendu(l: LigneFacture): number | null {
  if (l.prix_attendu != null && l.poids_etm != null) return Math.round(l.prix_attendu * l.poids_etm * 100) / 100
  if (l.montant != null && l.ecart_montant != null) return l.montant - l.ecart_montant
  return null
}
const montantKo = (l: LigneFacture) => {
  if (l.ecart_montant != null && l.ecart_montant > 0.005) return true
  const a = montantAttendu(l)
  return l.montant != null && a != null && l.montant - a > Math.max(1, 0.01 * a)
}
const signe = (n: number, dec: number, unite: string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtNum(Math.abs(n), dec)}${unite}`

// A conforme line is one row on this grid — billed = ETM, so each figure is
// written once, with its unit (no column header).
const GRILLE_LOT = 'grid grid-cols-[minmax(0,1fr)_84px_56px_80px_92px_92px] items-center gap-x-3'

/** The verdict pill — the switch while the invoice is open: flipping it means
 *  Tricobot got the line wrong, so it opens his « Je me suis trompé ! ». */
function PilleVerdict({ l, basculable, corrige, isPending, onDecider }: {
  l: LigneFacture; basculable: boolean; corrige: boolean; isPending: boolean; onDecider: (a: ActionLigne) => void
}) {
  const meta = VERDICT_META[l.verdict]
  if (!meta.label) return null
  if (!basculable) {
    return (
      <Badge variant="outline" className={cn('text-[10px] py-0 border', meta.badge, corrige && 'line-through opacity-60')}
        title={corrige ? 'Verdict de l’agent, corrigé' : 'Verdict de l’agent'}>
        {meta.label}
      </Badge>
    )
  }
  return (
    <button type="button" onClick={() => onDecider(l.verdict === 'conforme' ? 'ecart' : 'conforme')} disabled={isPending}
      title={l.verdict === 'conforme' ? 'Ce n’est pas conforme ? Cliquez pour le dire à Tricobot' : 'Ce n’est pas un écart ? Cliquez pour le dire à Tricobot'}
      className={cn('group/pill inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-all hover:shadow-sm hover:ring-2 hover:ring-accent/40 disabled:opacity-50', meta.badge)}>
      {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
      {meta.label}
      <ArrowLeftRight className="h-3 w-3 opacity-60 group-hover/pill:opacity-100" />
    </button>
  )
}

/** Lot, ETM ref chip, coloris (the sst order link lives in the expanded line). */
function IdentiteLot({ l, grand, ouvert }: { l: LigneFacture; grand?: boolean; ouvert?: boolean }) {
  // ETM's coloris; the dyer's own wording when ETM has none (no order line
  // tied, or an old sst line saved without a coloris, before #1215).
  const colorisMatel = !l.coloris_etm && !!l.designation
  const coloris = l.coloris_etm || l.designation
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {ouvert !== undefined && <ChevronDown className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform', ouvert && 'rotate-180')} />}
      <span className={cn('font-semibold tabular-nums flex-shrink-0', grand ? 'text-sm' : 'text-[13px]')}>{l.lot || '—'}</span>
      {l.ref_etm && (
        <span className="flex-shrink-0 rounded border border-accent/40 bg-accent/15 px-1 text-[11px] font-semibold"
          title="Référence ETM de la ligne de commande">{l.ref_etm}</span>
      )}
      {coloris && (
        <span className={cn('text-xs truncate', colorisMatel ? 'italic text-muted-foreground' : 'text-foreground/75')}
          title={colorisMatel ? `Libellé ${l.qualite ? 'MATEL' : 'du sous-traitant'} — pas de coloris sur la commande ETM` : coloris}>{coloris}</span>
      )}
    </div>
  )
}

// ── Billed vs ETM: one table for every lot line ─────────
// Écart cards show it always, conforme rows when clicked (decision Vincent
// 2026-10-05: synthetic, one small table; how ETM's
// price is made sits in a tooltip on the ETM price). The recipe and
// the sst order come from GET /factures-sst/lignes/:id/detail, rebuilt from
// today's tariff.

interface Ingredient { libelle: string; genre: 'teinture' | 'combinaison' | 'traitement'; brut: number; applique: number; multiplie: boolean }
interface RecettePrix {
  tranche: { poids: number; mini: number | null; maxi: number | null }
  rendement: number
  multiplicateur: number
  bandeRendement: { de: number | null; a: number | null } | null
  ingredients: Ingredient[]
  sansTarif: string[]
  total: number
}
interface DetailLigneData {
  commande: { id: number; date_commande: string | null } | null
  rouleaux: Array<{ numero: string; poids: number | null; metrage: number | null }>
  autres_factures: string[]
  prix: RecettePrix | null
}

/** Hover bubble rendered in a portal: the comparison table clips overflow,
 *  so an in-place absolute bubble would be cut off. */
function InfoBulle({ contenu, children }: { contenu: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; dessus: boolean } | null>(null)
  const ouvrir = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const largeur = 300
    const dessus = r.bottom + 220 > window.innerHeight
    setPos({ top: dessus ? r.top - 6 : r.bottom + 6, left: Math.max(8, Math.min(r.right - largeur, window.innerWidth - largeur - 8)), dessus })
  }
  return (
    <span ref={ref} onMouseEnter={ouvrir} onMouseLeave={() => setPos(null)} className="cursor-help underline decoration-dotted underline-offset-2">
      {children}
      {pos && createPortal(
        <div role="tooltip" style={{ top: pos.top, left: pos.left, width: 300 }}
          className={cn('fixed z-[60] rounded-md border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg', pos.dessus && '-translate-y-full')}>
          {contenu}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** How ETM's €/kg is made — the content of the ETM price tooltip. */
function RecetteBulle({ r }: { r: RecettePrix }) {
  const tranche = r.tranche.mini != null && r.tranche.maxi != null
    ? `${fmtNum(r.tranche.mini, 0)}–${r.tranche.maxi >= 99999 ? '∞' : fmtNum(r.tranche.maxi, 0)} kg`
    : '—'
  return (
    <div className="space-y-1.5 tabular-nums">
      <p className="font-semibold">Calcul du tarif ETM</p>
      <p className="text-[11px] text-muted-foreground">Tranche de poids {tranche}</p>
      {r.bandeRendement && (
        // MATEL bills by the kilo but charges more for light fabrics (more
        // metres per kilo): a multiplier by rendement band (pricing-sst.ts).
        <p className="text-[11px] text-muted-foreground">
          Rendement {fmtNum(r.rendement, 2)} Ml/kg (tranche {r.bandeRendement.de == null ? `≤ ${fmtNum(r.bandeRendement.a, 1)}` : r.bandeRendement.a == null ? `> ${fmtNum(r.bandeRendement.de, 1)}` : `${fmtNum(r.bandeRendement.de, 1)}–${fmtNum(r.bandeRendement.a, 1)}`})
          {' → '}{r.multiplicateur === 1 ? 'pas de majoration' : <>majoration MATEL <span className="font-semibold text-foreground">× {fmtNum(r.multiplicateur, 2)}</span></>}
        </p>
      )}
      <div className="space-y-0.5">
        {r.ingredients.map((i, k) => (
          <div key={k} className="flex items-baseline gap-2">
            <span className="w-2 text-muted-foreground">{k === 0 ? '' : '+'}</span>
            <span className="min-w-0 flex-1">{i.libelle}</span>
            <span className="text-muted-foreground">{fmtNum(i.brut, 2)}{i.multiplie && ` × ${fmtNum(r.multiplicateur, 2)}`}</span>
            <span className="w-12 text-right">{fmtNum(i.applique, 2)}</span>
          </div>
        ))}
        <div className="flex items-baseline gap-2 border-t pt-0.5 font-semibold">
          <span className="w-2">=</span>
          <span className="flex-1">Tarif ETM</span>
          <span className="w-12 text-right">{fmtNum(r.total, 2)} €</span>
        </div>
      </div>
      {r.sansTarif.length > 0 && <p className="text-[11px] text-amber-800">Sans tarif (0 €) : {r.sansTarif.join(', ')}</p>}
    </div>
  )
}

function TableComparaison({ l }: { l: LigneFacture }) {
  const navigate = useNavigate()
  const { data } = useQuery<DetailLigneData>({
    queryKey: ['facture-sst-ligne', l.id],
    queryFn: () => apiFetch(`/factures-sst/lignes/${l.id}/detail`),
  })
  const enKg = /^k/i.test(l.unite)
  const attendu = montantAttendu(l)
  // The price unit on all three rows: billed, ETM and the difference.
  const uPrix = `€/${enKg ? 'kg' : l.unite || 'u'}`
  const prixEtm = l.prix_attendu != null ? `${fmtNum(l.prix_attendu, 2)} ${uPrix}` : 'pas de tarif'
  // `diff` = billed − ETM: below zero the dyer billed less than ETM expected (in our favour, green).
  const colonnes: Array<{ label: string; ko: boolean; facture: React.ReactNode; etm: React.ReactNode; ecart: string | null; diff: number | null; neutre?: boolean }> = [
    {
      label: 'Poids', ko: enKg && poidsKo(l),
      facture: l.quantite != null ? `${fmtNum(l.quantite, enKg ? 2 : 0)} ${enKg ? 'kg' : l.unite}` : '—',
      etm: enKg && l.poids_etm != null ? `${fmtNum(l.poids_etm, 2)} kg` : '—',
      ecart: enKg && l.quantite != null && l.poids_etm != null ? signe(l.quantite - l.poids_etm, 2, ' kg') : null,
      diff: enKg && l.quantite != null && l.poids_etm != null ? l.quantite - l.poids_etm : null,
    },
    {
      label: 'Pièces', ko: piecesKo(l),
      facture: l.pieces != null ? fmtNum(l.pieces) : '—',
      etm: l.pieces_etm != null ? fmtNum(l.pieces_etm) : '—',
      ecart: l.pieces != null && l.pieces_etm != null ? signe(l.pieces - l.pieces_etm, 0, '') : null,
      diff: l.pieces != null && l.pieces_etm != null ? l.pieces - l.pieces_etm : null,
    },
    {
      label: 'Prix', ko: prixKo(l),
      facture: l.prix_unitaire != null ? `${fmtNum(l.prix_unitaire, 2)} ${uPrix}` : '—',
      etm: data?.prix ? <InfoBulle contenu={<RecetteBulle r={data.prix} />}>{prixEtm}</InfoBulle> : prixEtm,
      ecart: l.prix_unitaire != null && l.prix_attendu != null ? signe(l.prix_unitaire - l.prix_attendu, 2, ` ${uPrix}`) : null,
      diff: l.prix_unitaire != null && l.prix_attendu != null ? l.prix_unitaire - l.prix_attendu : null,
    },
    {
      label: 'Montant', ko: montantKo(l),
      facture: l.montant != null ? `${fmtNum(l.montant, 2)} €` : 'non facturé',
      etm: attendu != null ? `${fmtNum(attendu, 2)} €` : '—',
      ecart: l.montant != null && attendu != null ? signe(l.montant - attendu, 2, ' €') : null,
      diff: l.montant != null && attendu != null ? l.montant - attendu : null,
    },
  ]
  const cellule = (c: (typeof colonnes)[number], ligne: 'facture' | 'etm' | 'ecart') => {
    const bord = ligne === 'facture' ? '' : 'border-t border-border/40'
    if (ligne === 'ecart') {
      return (
        <span key={c.label} className={cn(bord, 'px-2 py-1 text-right', c.ko ? 'bg-destructive/5 font-semibold text-destructive' : 'text-green-700')}>
          {c.ko ? c.ecart ?? '?'
            : c.neutre || c.ecart === null ? <span className="text-muted-foreground">—</span>
            : c.diff != null && c.diff < -0.005 ? <span className="font-semibold" title="En faveur d’ETM">{c.ecart}</span>
            : <CheckCircle2 className="ml-auto h-3.5 w-3.5" />}
        </span>
      )
    }
    return (
      <span key={c.label} className={cn(bord, 'px-2 py-1 text-right truncate',
        ligne === 'etm' && 'text-muted-foreground', c.ko && 'bg-destructive/5', c.ko && ligne === 'facture' && 'font-semibold text-destructive')}>
        {c[ligne]}
      </span>
    )
  }

  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-[52px_repeat(4,minmax(0,1fr))] overflow-hidden rounded-md border border-border/60 bg-white text-[12px] tabular-nums">
        <span className="bg-zinc-100 px-2 py-1" />
        {colonnes.map((c) => (
          <span key={c.label} className={cn('px-2 py-1 text-right text-[10px] uppercase tracking-wide',
            c.ko ? 'bg-destructive/10 font-semibold text-destructive' : 'bg-zinc-100 text-muted-foreground')}>{c.label}</span>
        ))}
        <span className="px-2 py-1 text-[11px] text-muted-foreground">Facturé</span>
        {colonnes.map((c) => cellule(c, 'facture'))}
        <span className="border-t border-border/40 px-2 py-1 text-[11px] text-muted-foreground">ETM</span>
        {colonnes.map((c) => cellule(c, 'etm'))}
        <span className="border-t border-border/40 px-2 py-1 text-[11px] text-muted-foreground">Écart</span>
        {colonnes.map((c) => cellule(c, 'ecart'))}
      </div>
      {(data?.commande || (data && data.autres_factures.length > 0)) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
          {data?.commande && (
            <button type="button" onClick={() => navigate(`/sous-traitants/commandes?commande=${data.commande!.id}`)}
              className="inline-flex items-center gap-1 text-accent-blue hover:underline">
              Commande sous-traitant {data.commande.id}{data.commande.date_commande ? ` du ${formatHfsqlDate(data.commande.date_commande)}` : ''}
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {data && data.autres_factures.length > 0 && (
            <span className="text-destructive">Lot aussi facturé sur {data.autres_factures.join(', ')}</span>
          )}
        </div>
      )}
    </div>
  )
}

function LigneCard({ ligne: l, ouverte, isPending, onDecider, onAnnuler }: {
  ligne: LigneFacture
  ouverte: boolean
  isPending: boolean
  onDecider: (action: ActionLigne) => void
  onAnnuler: () => void
}) {
  const meta = VERDICT_META[l.verdict]
  const estLot = l.genre === 'lot'
  const final = verdictFinalDe(l)
  // The person's decision shows when it is more than a silent confirmation.
  const decisionVisible = !!l.verdict_final && (l.avis_note !== 'reussite' || !!l.avis_commentaire)
  const bord = l.verdict_final === 'ecart' ? 'border-l-destructive/60' : l.verdict_final === 'conforme' ? 'border-l-green-500/60' : meta.border
  // A real gap kept but with Tricobot's cause or amount corrected (avis.ts: écart réel + corriger).
  const tricobotCorrige = l.verdict === 'ecart' && l.verdict_final === 'ecart' && l.avis_note === 'echec'
  const corrige = !!l.verdict_final && final !== avisAgentDe(l.verdict)
  const basculable = ouverte && estLot && !l.verdict_final && l.verdict !== 'info'
  const enKg = /^k/i.test(l.unite)
  const [ouvert, setOuvert] = useState(false)
  // The pill must not also toggle the row.
  const pille = <span onClick={(e) => e.stopPropagation()}><PilleVerdict l={l} basculable={basculable} corrige={corrige} isPending={isPending} onDecider={onDecider} /></span>

  const decision = (
    <>
      {decisionVisible && tricobotCorrige && (
        <TricobotCorrection className="mt-1.5" commentaire={l.avis_commentaire ?? ''} par={l.avis_par_nom}
          onAnnuler={ouverte ? onAnnuler : undefined} disabled={isPending} />
      )}
      {decisionVisible && !tricobotCorrige && (
        <div className={cn('mt-1.5 rounded-md border px-2.5 py-1 text-[11px] flex items-start gap-1.5',
          l.verdict_final === 'ecart' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-green-500/30 bg-green-500/5 text-green-800')}>
          {l.verdict_final === 'ecart' ? <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" /> : <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-px" />}
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{l.verdict_final === 'ecart' ? (l.verdict === 'conforme' ? 'Écart signalé' : 'Écart confirmé') : 'Conforme'}</span>
            {l.avis_commentaire && <span className="text-foreground"> — {l.avis_commentaire}</span>}
            <span className="text-muted-foreground"> · {l.avis_par_nom ?? '—'}</span>
          </span>
          {ouverte && (
            <button type="button" onClick={onAnnuler} disabled={isPending} className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors">
              Annuler
            </button>
          )}
        </div>
      )}
    </>
  )

  // ── Packaging, transport, discounts: one quiet row ──
  if (!estLot) {
    return (
      <div className={cn('rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 px-3 py-1.5 flex items-center gap-3 text-xs', bord)}>
        <span className="min-w-0 flex-1 truncate" title={l.designation}>{l.designation || '—'}</span>
        {l.quantite != null && <span className="tabular-nums text-muted-foreground">{fmtNum(l.quantite, 2)} {l.unite || ''}</span>}
        {l.prix_unitaire != null && <span className="tabular-nums text-muted-foreground">{fmtNum(l.prix_unitaire, 2)} €</span>}
        <span className="w-24 text-right text-[13px] font-semibold tabular-nums">{l.montant != null ? `${fmtNum(l.montant, 2)} €` : 'non facturé'}</span>
      </div>
    )
  }

  // ── Conforme: one row, each figure once (billed = ETM); click for the table ──
  if (final === 'conforme') {
    const sousTarif = l.controles.find((c) => c.code === 'prix_inferieur')
    return (
      <div className={cn('rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 px-3 py-1.5 transition-colors', ouvert ? 'bg-white shadow-sm' : 'hover:bg-zinc-100', bord)}>
        <div className={cn(GRILLE_LOT, 'cursor-pointer select-none')} onClick={() => setOuvert((v) => !v)} title={ouvert ? 'Replier' : 'Voir le détail'}>
          <IdentiteLot l={l} ouvert={ouvert} />
          <span className="text-right text-[13px] tabular-nums">{l.quantite != null ? `${fmtNum(l.quantite, enKg ? 2 : 0)} ${enKg ? 'kg' : l.unite}` : '—'}</span>
          <span className="text-right text-[13px] tabular-nums">{l.pieces != null ? `${fmtNum(l.pieces)} pce` : '—'}</span>
          <span className="text-right text-[13px] tabular-nums inline-flex items-center justify-end gap-1">
            {sousTarif && <span title={sousTarif.message}><TrendingDown className="h-3 w-3 text-green-600" /></span>}
            {l.prix_unitaire != null ? `${fmtNum(l.prix_unitaire, 2)} €/${enKg ? 'kg' : l.unite || 'u'}` : '—'}
          </span>
          <span className="text-right text-[13px] font-semibold tabular-nums">{l.montant != null ? `${fmtNum(l.montant, 2)} €` : '—'}</span>
          <div className="flex justify-end">{pille}</div>
        </div>
        {ouvert && <TableComparaison l={l} />}
        {decision}
      </div>
    )
  }

  // ── Écart: the table always shows exactly what is wrong ──
  const raisons = l.controles.filter((c) => c.gravite !== 'info')
  const infos = l.controles.filter((c) => c.gravite === 'info')

  return (
    <div className={cn('rounded-lg border-l-4 border border-border/60 bg-white p-3 shadow-sm', bord)}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><IdentiteLot l={l} grand /></div>
        {pille}
      </div>
      <TableComparaison l={l} />
      {(raisons.length > 0 || infos.length > 0) && (
        <ul className="mt-2 space-y-0.5">
          {[...raisons, ...infos].map((c, i) => (
            <li key={i} className={cn('text-[11px] flex items-start gap-1.5',
              c.code === 'prix_inferieur' ? 'text-green-700' : c.gravite === 'info' ? 'text-muted-foreground' : 'text-destructive')}>
              {/* Billed under the tariff is in ETM's favour: same green arrow as on the conforme rows. */}
              {c.code === 'prix_inferieur' ? <TrendingDown className="h-3 w-3 flex-shrink-0 mt-0.5" />
                : c.gravite === 'info' ? <Info className="h-3 w-3 flex-shrink-0 mt-0.5" />
                : <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />}
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
      )}
      {decision}
    </div>
  )
}

// ── Right panel ────────────────────────────────────────

function KV({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate tabular-nums', strong && 'font-semibold')}>{value}</span>
    </div>
  )
}

function DetailSidebar({ facture, isLoading, onTraiter, onClore, onChanged, isTraiting }: {
  facture: FactureDetail | null
  isLoading: boolean
  onTraiter: (t: Traitement, commentaire: string) => Promise<unknown>
  onClore: (commentaire: string) => Promise<unknown>
  onChanged: () => void
  isTraiting: boolean
}) {
  const [onglet, setOnglet] = useState<'info' | 'historique'>('info')
  if (isLoading || !facture) {
    return (
      <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  const lots = new Set(facture.lignes.filter((l) => l.lot).map((l) => l.lot)).size
  const remarques = facture.controles
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {([['info', 'Informations', Info], ['historique', 'Historique', History]] as const).map(([k, label, I]) => (
            <button key={k} type="button" onClick={() => setOnglet(k)}
              className={cn('flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                onglet === k ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10')}>
              <I className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>
        {onglet === 'historique' ? <HistoriqueTab idFacture={facture.id} /> : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <KV label="Sous-traitant" value={facture.sous_traitant} />
            <KV label="Lots facturés" value={fmtNum(lots)} />
            <KV label="Total HT" value={facture.total_ht != null ? `${fmtNum(facture.total_ht, 2)} €` : '—'} strong />
            <KV label="Total TTC" value={facture.total_ttc != null ? `${fmtNum(facture.total_ttc, 2)} €` : '—'} />
            <KV label="Reçue le" value={new Date(facture.cree_le).toLocaleDateString('fr-FR')} />
          </div>
          <BilanEcarts lignes={facture.lignes} />
          {remarques.length > 0 && (
            <div className="p-3 rounded-lg border bg-card shadow-sm">
              <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"><MessageSquareWarning className="h-3.5 w-3.5" />Remarques sur la lecture</p>
              <ul className="space-y-1">
                {remarques.map((c, i) => (
                  <li key={i} className={cn('text-xs', c.gravite === 'bloquant' ? 'text-destructive' : 'text-muted-foreground')}>{c.message}</li>
                ))}
              </ul>
              {remarques.some((c) => c.gravite === 'bloquant') && (
                <p className="text-[11px] text-muted-foreground mt-2 italic">Lecture incertaine : aucun n° de facture n’a été reporté sur les commandes. Vérifiez avec le PDF.</p>
              )}
            </div>
          )}
          {facture.traitement && (
            <div className="p-3 rounded-lg border bg-card shadow-sm">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                {facture.traitement === 'validee' ? 'Validée' : 'Réclamée'} par {facture.traite_par_nom ?? '—'}
                {facture.traite_le ? ` le ${new Date(facture.traite_le).toLocaleDateString('fr-FR')}` : ''}
              </p>
              {facture.traite_commentaire?.trim()
                ? <p className="text-sm text-muted-foreground whitespace-pre-line">{facture.traite_commentaire.trim()}</p>
                : <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>}
            </div>
          )}
          {facture.traitement === 'reclamation_close' && (
            <div className="p-3 rounded-lg border bg-card shadow-sm">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                Réclamation close par {facture.cloture_par_nom ?? '—'}{facture.cloture_le ? ` le ${new Date(facture.cloture_le).toLocaleDateString('fr-FR')}` : ''}
              </p>
              <p className="text-sm text-muted-foreground whitespace-pre-line">{facture.cloture_commentaire}</p>
            </div>
          )}
        </div>
        )}
      </div>
      <TraitementFooter facture={facture} onTraiter={onTraiter} onClore={onClore} onChanged={onChanged} isTraiting={isTraiting} />
    </div>
  )
}

/** Billed vs what ETM expected, over every lot line — the same figures as the
 *  lines' tables (ETM amount = ETM weight × tariff, montantAttendu): what was
 *  billed above, what below, and the net (2026-10-05; the agent's stored
 *  ecart_montant only counts the price gaps it could verify). */
function BilanEcarts({ lignes }: { lignes: LigneFacture[] }) {
  let trop = 0, moins = 0, nTrop = 0, nMoins = 0, sansEtm = 0
  for (const l of lignes) {
    if (l.genre !== 'lot' || l.montant == null) continue
    const a = montantAttendu(l)
    if (a == null) { sansEtm++; continue }
    const d = Math.round((l.montant - a) * 100) / 100
    if (d >= 0.01) { trop += d; nTrop++ } else if (d <= -0.01) { moins += -d; nMoins++ }
  }
  const net = Math.round((trop - moins) * 100) / 100
  const lots = (n: number) => `${n} lot${n > 1 ? 's' : ''}`
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground mb-1">Écarts de facturation</p>
      <KV label={`Facturé en trop${nTrop ? ` (${lots(nTrop)})` : ''}`}
        value={<span className={cn(trop > 0 && 'text-destructive')}>{trop > 0 ? '+' : ''}{fmtNum(trop, 2)} €</span>} />
      <KV label={`Facturé en moins${nMoins ? ` (${lots(nMoins)})` : ''}`}
        value={<span className={cn(moins > 0 && 'text-green-700')}>{moins > 0 ? '−' : ''}{fmtNum(moins, 2)} €</span>} />
      <div className="border-t border-border/60 pt-1.5">
        <KV label={net < 0 ? 'Écart net, en notre faveur' : 'Écart net'} strong
          value={<span className={cn(net > 0 ? 'text-destructive' : net < 0 ? 'text-green-700' : '')}>{net > 0 ? '+' : net < 0 ? '−' : ''}{fmtNum(Math.abs(net), 2)} €</span>} />
      </div>
      {sansEtm > 0 && <p className="text-[11px] text-muted-foreground">{lots(sansEtm)} sans tarif ETM, non compté{sansEtm > 1 ? 's' : ''}.</p>}
    </div>
  )
}

/** The text of a réclamation, pre-filled from the lines left in écart. */
function brouillonReclamation(f: FactureDetail): string {
  // Only what a person kept as a real gap — never an écart « non vérifié » left untouched.
  const lignes = f.lignes.filter((l) => l.genre === 'lot' && (l.verdict_final === 'ecart' || (!l.verdict_final && l.verdict === 'ecart' && l.nature === 'reel')))
  const motif = (l: LigneFacture) => l.avis_commentaire?.trim() || l.controles.find((c) => c.gravite !== 'info')?.message || 'à vérifier'
  const corps = lignes.map((l) => `- lot ${l.lot.replace(/^[A-Z]+/, '') || l.designation} : ${motif(l)}`).join('\n')
  const trop = lignes.reduce((s, l) => s + (l.verdict_final ? 0 : l.ecart_montant ?? 0), 0)
  return `Facture ${f.numero} — merci de vérifier :\n${corps}${trop > 0 ? `\n\nMontant facturé en trop selon notre tarif : ${fmtNum(trop, 2)} €.` : ''}`
}

/** §29.4 footer: the invoice's state, and « Changer » to close it. An open
 *  invoice is closed only once every line the agent could not decide is
 *  decided; « Valider » confirms every untouched line. */
function TraitementFooter({ facture, onTraiter, onClore, onChanged, isTraiting }: {
  facture: FactureDetail
  onTraiter: (t: Traitement, commentaire: string) => Promise<unknown>
  onClore: (commentaire: string) => Promise<unknown>
  isTraiting: boolean
  onChanged: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<'reclamee' | 'validee_ecarts' | 'cloture' | null>(null)
  // « Réclamer au sous-traitant » opens the email to the dyer (2026-10-05);
  // « Réclamer sans email » inside it falls back to the comment dialog.
  const [emailOpen, setEmailOpen] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  useEffect(() => { setErreur(null) }, [facture.id])

  const lots = facture.lignes.filter((l) => l.genre === 'lot')
  const lecture = facture.controles.some((c) => c.gravite === 'bloquant')
  const nbEcarts = lots.filter((l) => verdictFinalDe(l) === 'ecart').length + (lecture ? 1 : 0)
  const etat: Etat = facture.traitement ? etatDe(facture) : nbEcarts > 0 ? 'ecarts' : 'a_valider'
  const meta = ETAT_META[etat]
  const Icon = meta.icon
  const lancer = (t: Traitement, commentaire = '') => {
    setErreur(null)
    onTraiter(t, commentaire).catch((e: Error) => setErreur(e.message))
  }
  type Choix = { key: string; label: string; icon: ComponentType<{ className?: string }>; run: () => void }
  const choix: Choix[] = facture.traitement === 'reclamee'
    ? [
        { key: 'clore', label: 'Clore la réclamation', icon: CheckCircle2, run: () => setDialog('cloture') },
        { key: 'rouvrir', label: 'Remettre à traiter', icon: RotateCcw, run: () => lancer(null) },
      ]
    : facture.traitement
    ? [{ key: 'rouvrir', label: 'Remettre à traiter', icon: RotateCcw, run: () => lancer(null) }]
    : nbEcarts === 0
      ? [{ key: 'valider', label: 'Valider la facture', icon: CheckCircle2, run: () => lancer('validee') }]
      : [
          { key: 'reclamer', label: 'Réclamer au sous-traitant', icon: Send, run: () => setEmailOpen(true) },
          { key: 'valider_ecarts', label: 'Valider malgré les écarts', icon: CheckCircle2, run: () => setDialog('validee_ecarts') },
        ]

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      {erreur && <p className="mb-1.5 text-xs text-destructive flex items-start gap-1"><AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />{erreur}</p>}
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={isTraiting}
          title="Traiter la facture"
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          {isTraiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
          Changer
        </button>
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {choix.map((c) => {
            const CIcon = c.icon
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => { setMenuOpen(false); c.run() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-white"
              >
                <CIcon className="h-4 w-4" />{c.label}
              </button>
            )
          })}
        </div>
      )}
      <SendEmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        title="Réclamation"
        contextLabel={`${facture.sous_traitant} · facture ${facture.numero}`}
        queryKey={['facture-sst-reclamation', facture.id]}
        loadDefaults={() => apiFetch<EmailDefaults>(`/factures-sst/${facture.id}/reclamation/email-defaults`)}
        pdfUrl={facture.a_pdf ? `${API_URL}/factures-sst/${facture.id}/pdf` : undefined}
        pdfAttachmentLabel={facture.pdf_nom ?? `facture-${facture.numero}.pdf`}
        onSend={async (p) => {
          await postEmail(`${API_URL}/factures-sst/${facture.id}/reclamation/email`, p, { includeAttachPdf: facture.a_pdf })
          onChanged()
        }}
        secondaryAction={{ label: 'Réclamer sans email', onClick: () => { setEmailOpen(false); setDialog('reclamee') } }}
      />
      <TraitementDialog
        mode={dialog}
        facture={facture}
        isPending={isTraiting}
        onClose={() => setDialog(null)}
        onConfirm={async (commentaire) => {
          if (!dialog) return
          if (dialog === 'cloture') await onClore(commentaire)
          else await onTraiter(dialog === 'reclamee' ? 'reclamee' : 'validee', commentaire)
          setDialog(null)
        }}
      />
    </div>
  )
}

function TraitementDialog({ mode, facture, isPending, onClose, onConfirm }: {
  mode: 'reclamee' | 'validee_ecarts' | 'cloture' | null
  facture: FactureDetail
  isPending: boolean
  onClose: () => void
  onConfirm: (commentaire: string) => Promise<void>
}) {
  const [commentaire, setCommentaire] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (mode) { setCommentaire(mode === 'reclamee' ? brouillonReclamation(facture) : ''); setError(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])
  const reclame = mode === 'reclamee'
  const cloture = mode === 'cloture'
  const TitleIcon = reclame ? Send : CheckCircle2
  return (
    <Dialog open={mode !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TitleIcon className="h-5 w-5 text-accent" />
            {reclame ? `Réclamer — facture ${facture.numero}` : cloture ? `Clore la réclamation — ${facture.numero}` : `Valider malgré les écarts — ${facture.numero}`}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <p className="text-sm text-muted-foreground">
            {reclame
              ? 'Ce qui est demandé au sous-traitant, pré-rempli depuis les lignes en écart : relisez, complétez, puis copiez-le dans votre mail. Il reste sur la facture.'
              : cloture
              ? 'Comment la réclamation s’est terminée : avoir, remise sur une prochaine facture (laquelle ?), facture corrigée, explication acceptée…'
              : 'Des lignes restent en écart. Dites pourquoi la facture est validée quand même (geste commercial, prix convenu…).'}
          </p>
          <textarea
            rows={reclame ? 8 : 4}
            value={commentaire}
            onChange={(e) => setCommentaire(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button
            disabled={isPending || !commentaire.trim()}
            onClick={async () => {
              setError(null)
              try { await onConfirm(commentaire.trim()) } catch (e) { setError(e instanceof Error ? e.message : 'Erreur') }
            }}
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <TitleIcon className="h-3.5 w-3.5 mr-1.5" />}
            {reclame ? 'Réclamer' : cloture ? 'Clore' : 'Valider'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Historique tab ─────────────────────────────────────
// Every step of the invoice, oldest first (GET /factures-sst/:id/historique,
// lib/agents/factures-sst/historique.ts — append-only).

interface EvenementFacture {
  id: number
  le: string
  type: 'recue' | 'ligne' | 'validee' | 'reclamee' | 'reclamation_close' | 'rouverte'
  par_nom: string | null
  resume: string
  details: { email?: { to: string[]; cc: string[]; subject: string; corps?: string } }
}

const EVENEMENT_META: Record<EvenementFacture['type'], { label: string; icon: ComponentType<{ className?: string }>; cls: string }> = {
  recue: { label: 'Reçue', icon: TricobotMascot, cls: 'bg-white' },
  ligne: { label: 'Ligne', icon: Pencil, cls: 'bg-zinc-100 text-muted-foreground' },
  validee: { label: 'Validée', icon: CheckCircle2, cls: 'bg-green-500/10 text-green-700' },
  reclamee: { label: 'Réclamée', icon: Send, cls: 'bg-amber-500/15 text-amber-700' },
  reclamation_close: { label: 'Réclamation close', icon: CheckCircle2, cls: 'bg-green-500/10 text-green-700' },
  rouverte: { label: 'Remise à traiter', icon: RotateCcw, cls: 'bg-zinc-100 text-muted-foreground' },
}

function HistoriqueTab({ idFacture }: { idFacture: number }) {
  const { data, isLoading, isError } = useQuery<{ evenements: EvenementFacture[] }>({
    queryKey: ['facture-sst-historique', idFacture],
    queryFn: () => apiFetch(`/factures-sst/${idFacture}/historique`),
  })
  const [ouvert, setOuvert] = useState<number | null>(null)
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
  if (isError) return <div className="flex-1 flex items-center justify-center text-sm text-destructive"><AlertCircle className="h-4 w-4 mr-1.5" />Historique indisponible</div>
  const evenements = data?.evenements ?? []
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
      {evenements.length === 0 && <p className="text-sm text-muted-foreground italic text-center py-6">Aucun événement</p>}
      {evenements.map((e) => {
        const m = EVENEMENT_META[e.type]
        const I = m.icon
        const email = e.details?.email
        return (
          <div key={`${e.id}-${e.le}`} className="p-3 rounded-lg border bg-card shadow-sm">
            <div className="flex items-start gap-2">
              <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', m.cls)}>
                <I className={cn(e.type === 'recue' ? 'h-5 w-5' : 'h-3.5 w-3.5')} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-semibold">{m.label}</p>
                  <p className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                    {new Date(e.le).toLocaleDateString('fr-FR')} {new Date(e.le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <p className="text-xs text-foreground/80 whitespace-pre-line break-words">{e.resume}</p>
                {email && (
                  <div className="mt-1.5 rounded-md border border-border/60 bg-zinc-50 px-2 py-1.5 text-[11px] space-y-0.5">
                    <p className="flex items-center gap-1 font-medium"><AtSign className="h-3 w-3" />{email.subject}</p>
                    <p className="text-muted-foreground">À : {email.to.join(', ')}</p>
                    {email.cc.length > 0 && <p className="text-muted-foreground">Cc : {email.cc.join(', ')}</p>}
                    {email.corps && (
                      ouvert === e.id
                        ? <p className="mt-1 whitespace-pre-line text-foreground/80">{email.corps}</p>
                        : <button type="button" onClick={() => setOuvert(e.id)} className="text-accent-blue hover:underline">Voir le message</button>
                    )}
                  </div>
                )}
                {e.par_nom && <p className="mt-0.5 text-[10px] text-muted-foreground">{e.par_nom}</p>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── PDF viewer (§18.B) ─────────────────────────────────

function PdfDialog({ open, facture, onClose }: { open: boolean; facture: FactureDetail | null; onClose: () => void }) {
  return (
    <Dialog open={open && !!facture} onOpenChange={(o) => { if (!o) onClose() }}>
      {facture?.a_pdf ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe src={`${API_URL}/factures-sst/${facture.id}/pdf#view=FitH`} className="w-full h-full rounded-lg" title={`Facture ${facture.numero}`} />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <CircleSlash className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">Aucun PDF conservé pour cette facture</p>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
