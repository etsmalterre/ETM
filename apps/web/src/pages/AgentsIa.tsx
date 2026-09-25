// Agents IA › Agents — the « Classeur » layout (mps_designer §39): agents in
// the left list, master tabs in the center (Exécutions / Retours / Prompt /
// Coûts / Fonctionnement), overview in the right sidebar with the agent's
// mode as the §29.4 status footer (Arrêt / Essai / En service).
//
// API: /api/agents-ia (apps/api/src/routes/agents-ia.ts). Reads need only a
// session; piloting needs `edit_agents_ia`, scoring needs `evaluer_agents_ia`
// — both checked server-side too.
//
// Every run is scored the same way: réussite / partielle / échec, a comment
// required except for réussite (EvaluationPanel). The Superviseur's report
// scores each of its points too. The « Retours » tab gathers every comment of
// a version — what the next prompt is written from.
//
// A BL run opens in a side-by-side dialog (what the agent read on the left,
// the PDF on the right); a Superviseur run opens on its report. The email
// sent for a BL « à vérifier » links here with ?agent=<slug>&run=<id>.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CircleDollarSign,
  CircleSlash,
  Clock,
  Copy,
  EyeOff,
  ExternalLink,
  FileText,
  FlaskConical,
  History,
  Inbox,
  Info,
  ListChecks,
  Loader2,
  CircleHelp,
  Mail,
  MessageSquare,
  MessagesSquare,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  ShieldCheck,
  Upload,
  Workflow,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Types (mirror routes/agents-ia.ts) ───────────────────

type Mode = 'off' | 'essai' | 'actif'
type Statut = 'ecrit' | 'simule' | 'a_verifier' | 'deja_importe' | 'ignore' | 'erreur' | 'points_a_voir' | 'rien_a_signaler' | 'mail_envoye'
type Source = 'gmail' | 'essai_manuel' | 'retraitement' | 'planifie' | 'manuel'
type Note = 'reussite' | 'partielle' | 'echec'

interface Auteur { id: number; nom: string }

interface Evaluation {
  note: Note
  commentaire: string
  par: Auteur
  le: string
  /** What an échec removed from ETM (BL: the pre-filled pieces). */
  retrait?: string | null
}

/** How the points of one Superviseur report stand (a point scored on an
 *  earlier report counts as scored). */
interface BilanPoints {
  points: number
  evalues: number
  reussite: number
  partielle: number
  echec: number
  aEvaluer: number
}
interface ScorePoints extends BilanPoints {
  /** (réussite + partielle) / évalués, 0..1 — null while nothing is scored. */
  precision: number | null
}

interface GuideNotation {
  /** The one question that decides between the three scores. */
  question: string
  exemples: Record<Note, string>
  remarques: string[]
}

interface AgentVue {
  slug: string
  nom: string
  description: string
  declencheur: string
  ecritures: string[]
  abstention: string
  declenchement: { type: 'releve'; intervalleMs: number } | { type: 'quotidien'; heure: number; jours: number[] }
  /** What each score means for this agent (shown beside the three buttons). */
  evaluation: Record<Note, string>
  /** The scoring guide opened beside the buttons (catalog.ts `evaluation.guide`). */
  guideNotation: GuideNotation
  /** Superviseur: each point of the report is scored too. */
  pointsEvaluables: boolean
  /** Only the modes this agent offers. */
  modes: Partial<Record<Mode, string>>
  peutTester: boolean
  prochaineExecution: string | null
  controles: Array<{ id: string; libelle: string; description: string }>
  mode: Mode
  startedAt: string | null
  modeChangedAt: string | null
  modeChangedBy: Auteur | null
  versionActive: { version: number; model: string }
  stats: {
    total: number
    parStatut: Partial<Record<Statut, number>>
    evaluations: Record<Note, number> & { aEvaluer: number }
    /** Point-scored agents: every finding the version raised, by its latest score. */
    points: ScorePoints | null
    coutUsd: number
    dernierRun: string | null
  }
  sondage: {
    dernierSondage: string | null
    dernierSucces: string | null
    derniereErreur: string | null
    dernierLancement: Lancement | null
    enCours: boolean
  }
}

/** A « Relever / Lancer maintenant »: the POST answers at once, the screen
 *  polls the agent until `fin` (a run can outlast the 60 s proxy timeout). */
interface Lancement {
  id: string
  debut: string
  fin: string | null
  runs: Array<{ id: string; statut: Statut; resume: string }>
  erreur: string | null
}

interface AgentVersion {
  version: number
  model: string
  prompt: string
  note: string
  createdBy: Auteur | null
  createdAt: string
}

interface AgentDetail extends AgentVue {
  activeVersion: number
  versions: AgentVersion[]
  modeles: Array<{ id: string; label: string }>
  /** A prompt shipped with the code that no stored version carries yet. */
  promptLivre?: { model: string; prompt: string; note: string } | null
}

interface RunLigne {
  id: string
  createdAt: string
  source: Source
  mode: Mode
  statut: Statut
  resume: string
  coutUsd: number
  dureeMs: number
  version: number
  model: string
  erreur?: string
  bordereau: string | null
  commande: string | null
  nbPieces: number | null
  message?: { de: string; sujet: string; date: string } | null
  lancePar?: Auteur | null
  retraiteDe?: string
  evaluation?: Evaluation | null
  fichiers: Array<{ nom: string; taille: number }>
  // Superviseur
  nbNouveaux: number | null
  nbOuverts: number | null
  nbFermes: number | null
  nbEcartes: number | null
  bilan: BilanPoints | null
}

interface Controle { code: string; gravite: 'bloquant' | 'avertissement'; message: string }
interface BlPiece { numero_piece: string; poids: number | null; metrage: number | null; observations: string }
interface PieceResolue { numero_piece: string; statut: 'ok' | 'affectee_ailleurs' | 'inconnue' }

interface RunComplet extends Omit<RunLigne, 'bordereau' | 'commande' | 'nbPieces'> {
  resultat: {
    pages?: Array<{ nom: string; ocr: string | null; erreur: string | null }>
    extraction?: {
      numero_commande: string
      numero_bordereau: string
      ligne: number | null
      pieces: BlPiece[]
      nombre_pieces: number | null
      poids_total: number | null
      metrage_total: number | null
    } | null
    resolution?: { commandeId: number | null; ligneId: number | null; lot: string; pieces: PieceResolue[] } | null
    controles?: Controle[]
    ecriture?: { gedId: number | null; lignesEcrites: number; retire?: { le: string; lignes: number } | null } | null
  }
}

/** A point someone marked résolu, with why (GET /:slug/retours). */
interface RetourResolution { runId: string; runLe: string; titre: string; commentaire: string; par: Auteur; le: string }

/** One comment of the « Retours » tab (GET /:slug/retours). */
interface Retour {
  runId: string
  runLe: string
  source: Source
  portee: 'execution' | 'point'
  titre: string | null
  note: Note
  commentaire: string
  par: Auteur
  le: string
  retrait: string | null
}

interface Couts {
  jours: number
  totalUsd: number
  runs: number
  moyenneUsd: number
  parJour: Array<{ jour: string; coutUsd: number; runs: number }>
}

// ── Helpers ──────────────────────────────────────────────

/** fetch that keeps the API's French `error` message (apiFetch drops it). */
async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: init?.body instanceof FormData ? init?.headers : { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(json?.error || `Erreur HTTP ${res.status}`)
  return json as T
}

const fmtDateHeure = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

function ilYA(iso: string | null | undefined): string {
  if (!iso) return 'jamais'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'à l’instant'
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`
  return fmtDateHeure(iso)
}

const fmtDateCourte = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** Costs are tracked in USD (Mistral's price list); shown in € at a fixed indicative rate. */
const EUR_PER_USD = 0.86

/** € cost to the centime; anything under a centime (a BL is about 0,005 $) reads « < 0,01 € ». */
const fmtEur = (usd: number) => {
  const eur = usd * EUR_PER_USD
  if (eur <= 0) return '0,00 €'
  return eur < 0.01 ? '< 0,01 €' : `${fmtNum(eur, 2)} €`
}

// Per-agent mode descriptions come from the catalog (AgentVue.modes).
const MODE_META: Record<Mode, { label: string; icon: ComponentType<{ className?: string }>; solid: string }> = {
  off: { label: 'À l’arrêt', icon: CircleSlash, solid: 'bg-zinc-500 border-zinc-500' },
  essai: { label: 'En essai', icon: FlaskConical, solid: 'bg-sky-600 border-sky-600' },
  actif: { label: 'En service', icon: Power, solid: 'bg-success border-success' },
}
const MODE_ORDER: Mode[] = ['off', 'essai', 'actif']

const STATUT_META: Record<Statut, { label: string; solid: string; icon: ComponentType<{ className?: string }> }> = {
  ecrit: { label: 'Enregistré', solid: 'bg-success border-success', icon: CheckCircle2 },
  simule: { label: 'Simulé', solid: 'bg-sky-600 border-sky-600', icon: FlaskConical },
  a_verifier: { label: 'À vérifier', solid: 'bg-destructive border-destructive', icon: AlertTriangle },
  deja_importe: { label: 'Déjà importé', solid: 'bg-zinc-500 border-zinc-500', icon: Copy },
  ignore: { label: 'Ignoré', solid: 'bg-zinc-400 border-zinc-400', icon: CircleSlash },
  erreur: { label: 'Erreur', solid: 'bg-red-800 border-red-800', icon: XCircle },
  points_a_voir: { label: 'Points à voir', solid: 'bg-amber-500 border-amber-500', icon: ListChecks },
  rien_a_signaler: { label: 'Rien à signaler', solid: 'bg-success border-success', icon: CheckCircle2 },
  // Superviseur runs from before 2026-09-23, when the report was mailed.
  mail_envoye: { label: 'Mail envoyé', solid: 'bg-amber-500 border-amber-500', icon: Mail },
}

// One hue per score, everywhere (list pills, buttons, the Retours tab).
const NOTE_META: Record<Note, {
  label: string
  icon: ComponentType<{ className?: string }>
  solid: string
  soft: string
  text: string
  border: string
  hover: string
}> = {
  reussite: { label: 'Réussite', icon: CheckCircle2, solid: 'bg-success border-success', soft: 'bg-green-500/10 border-green-500/30', text: 'text-green-700', border: 'border-l-green-500/60', hover: 'hover:bg-green-500/10' },
  partielle: { label: 'Partielle', icon: CircleDashed, solid: 'bg-amber-500 border-amber-500', soft: 'bg-amber-500/10 border-amber-500/30', text: 'text-amber-800', border: 'border-l-amber-400/60', hover: 'hover:bg-amber-500/10' },
  echec: { label: 'Échec', icon: XCircle, solid: 'bg-destructive border-destructive', soft: 'bg-destructive/10 border-destructive/30', text: 'text-destructive', border: 'border-l-destructive/60', hover: 'hover:bg-destructive/10' },
}
const NOTE_ORDER: Note[] = ['reussite', 'partielle', 'echec']

/** The run's score, or « À évaluer » when nobody scored it yet. */
function NotePill({ evaluation, className }: { evaluation: Evaluation | null | undefined; className?: string }) {
  if (!evaluation) {
    return <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap', className)}><Clock className="h-3.5 w-3.5" />À évaluer</span>
  }
  const m = NOTE_META[evaluation.note]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap', m.text, className)} title={evaluation.commentaire || undefined}>
      <Icon className="h-3.5 w-3.5" />{m.label}
    </span>
  )
}

const SOURCE_LABEL: Record<Source, string> = {
  gmail: 'Mail', essai_manuel: 'Test', retraitement: 'Retraitement', planifie: 'Planifiée', manuel: 'Manuelle',
}

function StatutPill({ statut, className }: { statut: Statut; className?: string }) {
  const m = STATUT_META[statut]
  const Icon = m.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', m.solid, className)}>
      <Icon className="h-2.5 w-2.5" />{m.label}
    </Badge>
  )
}

// ── Page ─────────────────────────────────────────────────

export function AgentsIa() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const canPilot = useHasPermission('edit_agents_ia')
  const canEvaluate = useHasPermission('evaluer_agents_ia')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSlug, setSelectedSlug] = useState<string | null>(searchParams.get('agent'))
  const [openRunId, setOpenRunId] = useState<string | null>(searchParams.get('run'))
  const [essaiOpen, setEssaiOpen] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const { data: agents, isLoading, isError, error } = useQuery({
    queryKey: ['agents-ia'],
    queryFn: () => apiFetch<AgentVue[]>('/agents-ia'),
    refetchInterval: 30_000,
  })

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return (agents ?? []).filter((a) => !q || a.nom.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  }, [agents, searchQuery])

  // `undefined` while loading: an empty array would make the hook clear the
  // deep-linked ?agent= and fall back to the first agent.
  useAutoSelectFirst({ rows: agents ? filtered : undefined, selectedId: selectedSlug, getId: (a) => a.slug, select: setSelectedSlug })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['agent-ia', selectedSlug],
    queryFn: () => apiFetch<AgentDetail>(`/agents-ia/${selectedSlug}`),
    enabled: selectedSlug !== null,
    refetchInterval: 30_000,
  })

  // The deep link is consumed once: drop it from the URL so a reload doesn't reopen the run.
  useEffect(() => {
    if (searchParams.has('run') || searchParams.has('agent')) setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['agents-ia'] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia-runs', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia-couts', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia-retours', selectedSlug] })
  }, [queryClient, selectedSlug])

  const modeMut = useMutation({
    mutationFn: (mode: Mode) => callApi(`/agents-ia/${selectedSlug}`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    onSuccess: invalidate,
    onError: (e: Error) => setActionMessage({ tone: 'error', text: e.message }),
  })

  // The launch being waited for. Its polling query is keyed on the launch id,
  // so it only ever sees answers fetched AFTER the POST — never a stale
  // « not running » detail from before.
  const [attente, setAttente] = useState<string | null>(null)

  const sonderMut = useMutation({
    mutationFn: () => callApi<{ lancement: Lancement }>(`/agents-ia/${selectedSlug}/sonder`, { method: 'POST' }),
    onSuccess: (r) => setAttente(r.lancement.id),
    onError: (e: Error) => { invalidate(); setActionMessage({ tone: 'error', text: e.message }) },
  })

  const { data: suivi } = useQuery({
    queryKey: ['agent-ia-lancement', selectedSlug, attente],
    queryFn: () => apiFetch<AgentDetail>(`/agents-ia/${selectedSlug}`),
    enabled: attente !== null && selectedSlug !== null,
    refetchInterval: 2_000,
    gcTime: 0,
  })

  useEffect(() => {
    if (!suivi || attente === null) return
    queryClient.setQueryData(['agent-ia', selectedSlug], suivi)
    const l = suivi.sondage.dernierLancement
    if (l?.id === attente && !l.fin) return
    if (l?.id !== attente && suivi.sondage.enCours) return
    setAttente(null)
    invalidate()
    if (!l || l.id !== attente) {
      setActionMessage({ tone: 'error', text: 'L’exécution a été interrompue (redémarrage du serveur ?). Relancez-la.' })
      return
    }
    if (l.erreur) {
      setActionMessage({ tone: 'error', text: l.erreur })
      return
    }
    if (suivi.declenchement.type === 'quotidien') {
      const run = l.runs[0]
      setActionMessage(run ? { tone: run.statut === 'erreur' ? 'error' : 'ok', text: `Contrôle terminé : ${run.resume}.` } : { tone: 'ok', text: 'Aucun contrôle lancé.' })
      if (run) setOpenRunId(run.id)
      return
    }
    setActionMessage({ tone: 'ok', text: l.runs.length ? `${l.runs.length} nouveau(x) mail(s) traité(s).` : 'Aucun nouveau mail.' })
  }, [suivi, attente, selectedSlug, queryClient, invalidate])

  // Switching agents drops the wait; the run still finishes and lands in its list.
  useEffect(() => { setActionMessage(null); setAttente(null) }, [selectedSlug])

  return (
    <>
      <MasterDetailLayout
        list={<AgentList agents={filtered} total={agents?.length ?? 0} isLoading={isLoading} isError={isError}
          error={error as Error | null} selectedSlug={selectedSlug} onSelect={setSelectedSlug}
          searchQuery={searchQuery} onSearchChange={setSearchQuery} />}
        detailHeader={<DetailHeader agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null} canPilot={canPilot}
          onSonder={() => { setActionMessage(null); sonderMut.mutate() }} isSondant={sonderMut.isPending || attente !== null || !!detail?.sondage.enCours}
          onEssai={() => setEssaiOpen(true)} message={actionMessage} onDismissMessage={() => setActionMessage(null)} />}
        detail={<DetailMain agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null}
          hasSelection={selectedSlug !== null} canPilot={canPilot} onOpenRun={setOpenRunId} onChanged={invalidate} />}
        sidebar={selectedSlug !== null ? <DetailSidebar agent={detail ?? null} canPilot={canPilot}
          onChangeMode={(m) => modeMut.mutate(m)} isChangingMode={modeMut.isPending} /> : null}
        sidebarTitle="Aperçu"
        hasSelection={selectedSlug !== null}
        onBack={() => setSelectedSlug(null)}
      />
      {selectedSlug && detail?.slug === selectedSlug && detail.pointsEvaluables && (
        <SuperviseurRunDialog agent={detail} runId={openRunId} canEvaluate={canEvaluate} onClose={() => setOpenRunId(null)}
          onChanged={invalidate} />
      )}
      {selectedSlug && detail?.slug === selectedSlug && !detail.pointsEvaluables && (
        <RunDialog agent={detail} runId={openRunId} canPilot={canPilot} canEvaluate={canEvaluate} onClose={() => setOpenRunId(null)}
          onOpenRun={setOpenRunId} onChanged={invalidate} />
      )}
      {selectedSlug && (
        <EssaiDialog open={essaiOpen} slug={selectedSlug} onClose={() => setEssaiOpen(false)}
          onDone={(runId) => { setEssaiOpen(false); invalidate(); if (runId) setOpenRunId(runId) }} />
      )}
    </>
  )
}

// ── Left list ────────────────────────────────────────────

function AgentList({ agents, total, isLoading, isError, error, selectedSlug, onSelect, searchQuery, onSearchChange }: {
  agents: AgentVue[]; total: number; isLoading: boolean; isError: boolean; error: Error | null
  selectedSlug: string | null; onSelect: (slug: string) => void; searchQuery: string; onSearchChange: (q: string) => void
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input type="text" placeholder="Rechercher..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off" className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        : isError ? <div className="flex flex-col items-center justify-center py-8 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">{error?.message || 'Erreur'}</p></div>
        : agents.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><Bot className="h-12 w-12 mb-3 opacity-50" /><p className="text-sm">Aucun agent</p></div>
        : agents.map((a) => {
          const aVerifier = a.stats.parStatut.a_verifier ?? 0
          const m = MODE_META[a.mode]
          const MIcon = m.icon
          return (
            <div key={a.slug} onClick={() => onSelect(a.slug)}
              className={cn('p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedSlug === a.slug ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')}>
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{a.nom}</p>
                <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white flex-shrink-0', m.solid)}>
                  <MIcon className="h-2.5 w-2.5" />{m.label}
                </Badge>
              </div>
              <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">v{a.versionActive.version} · {a.versionActive.model}</span>
                {aVerifier > 0 && (
                  <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-destructive font-medium">
                    <AlertTriangle className="h-3 w-3" />{aVerifier} à vérifier
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{agents.length} / {total} agent{total !== 1 ? 's' : ''}</span>
      </div>
    </div>
  )
}

// ── Detail header ────────────────────────────────────────

function DetailHeader({ agent, isLoading, canPilot, onSonder, isSondant, onEssai, message, onDismissMessage }: {
  agent: AgentDetail | null; isLoading: boolean; canPilot: boolean
  onSonder: () => void; isSondant: boolean; onEssai: () => void
  message: { tone: 'ok' | 'error'; text: string } | null; onDismissMessage: () => void
}) {
  if (isLoading || !agent) {
    return isLoading ? <div className="flex-shrink-0 pt-0.5"><div className="h-8 w-48 bg-muted animate-pulse rounded" /></div> : null
  }
  const quotidien = agent.declenchement.type === 'quotidien'
  const sonderTitle = !canPilot ? 'Droit « Piloter les agents IA » requis'
    : agent.mode === 'off' ? 'L’agent est à l’arrêt : passez-le en essai ou en service'
    : quotidien ? 'Lancer les contrôles maintenant — ne change pas ce que dira le rapport de demain matin'
    : 'Relever la boîte mail maintenant'
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-lg flex items-center justify-center icon-box-gold">
          <Bot className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{agent.nom}</h1>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            <Badge variant="secondary" className="text-xs">Version {agent.versionActive.version}</Badge>
            <Badge variant="secondary" className="text-xs">{agent.modeles.find((m) => m.id === agent.versionActive.model)?.label ?? agent.versionActive.model}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {agent.peutTester && (
            <Button variant="outline" size="sm" onClick={onEssai} disabled={!canPilot}
              title={canPilot ? 'Tester l’agent sur un PDF, sans rien enregistrer' : 'Droit « Piloter les agents IA » requis'}>
              <Upload className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Tester un PDF</span>
            </Button>
          )}
          <Button variant="gold" size="sm" onClick={onSonder} disabled={!canPilot || agent.mode === 'off' || isSondant} title={sonderTitle}>
            {isSondant ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
              : quotidien ? <Play className="h-3.5 w-3.5 sm:mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 sm:mr-1.5" />}
            <span className="hidden sm:inline">{quotidien ? 'Lancer maintenant' : 'Relever maintenant'}</span>
          </Button>
        </div>
      </div>
      {message && (
        <div className={cn('mt-2 flex items-center gap-2 text-sm rounded-md px-3 py-1.5',
          message.tone === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
          {message.tone === 'ok' ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
          <span className="flex-1 min-w-0">{message.text}</span>
          <button type="button" onClick={onDismissMessage} className="opacity-60 hover:opacity-100" title="Fermer"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className="h-1 w-24 mt-3 rounded-full bg-gradient-to-r from-accent via-accent to-accent/30" />
    </div>
  )
}

// ── Center: master tabs (Classeur §39) ───────────────────

const MAIN_TABS = [
  { key: 'executions', label: 'Exécutions', icon: History },
  { key: 'retours', label: 'Retours', icon: MessagesSquare },
  { key: 'prompt', label: 'Prompt', icon: ScrollText },
  { key: 'couts', label: 'Coûts', icon: CircleDollarSign },
  { key: 'fonctionnement', label: 'Fonctionnement', icon: Workflow },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({ agent, isLoading, hasSelection, canPilot, onOpenRun, onChanged }: {
  agent: AgentDetail | null; isLoading: boolean; hasSelection: boolean; canPilot: boolean
  onOpenRun: (id: string) => void; onChanged: () => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('executions')
  useEffect(() => { setActiveTab('executions') }, [agent?.slug])

  if (!hasSelection) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <div className="icon-box-gold h-16 w-16 rounded-xl flex items-center justify-center mb-3"><Bot className="h-8 w-8" /></div>
        <p className="text-sm">Sélectionnez un agent</p>
      </div>
    )
  }
  if (isLoading || !agent) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2 overflow-x-auto">
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
      <div className="flex-1 min-h-0 overflow-auto space-y-2 pt-3 px-1 pb-1">
        {activeTab === 'executions' && (agent.pointsEvaluables
          ? <SuperviseurExecutionsTab slug={agent.slug} onOpenRun={onOpenRun} />
          : <ExecutionsTab slug={agent.slug} onOpenRun={onOpenRun} />)}
        {activeTab === 'retours' && <RetoursTab agent={agent} onOpenRun={onOpenRun} />}
        {activeTab === 'prompt' && <PromptTab agent={agent} canPilot={canPilot} onChanged={onChanged} />}
        {activeTab === 'couts' && <CoutsTab slug={agent.slug} />}
        {activeTab === 'fonctionnement' && <FonctionnementTab agent={agent} />}
      </div>
    </div>
  )
}

// ── Exécutions ───────────────────────────────────────────

const RUN_FILTERS: Array<{ key: string; label: string; query: string }> = [
  { key: 'tout', label: 'Toutes', query: '' },
  { key: 'verifier', label: 'À vérifier', query: '?statut=a_verifier,erreur' },
  { key: 'ecrit', label: 'Enregistrées', query: '?statut=ecrit' },
  { key: 'simule', label: 'Simulées', query: '?statut=simule' },
  { key: 'a_evaluer', label: 'À évaluer', query: '?note=a_evaluer' },
  { key: 'mal', label: 'Partielles / échecs', query: '?note=partielle,echec' },
]

/** The score as one icon, for tight table cells (full label in the title). */
function NoteIcon({ evaluation }: { evaluation: Evaluation | null | undefined }) {
  if (!evaluation) return null
  const m = NOTE_META[evaluation.note]
  const Icon = m.icon
  return (
    <span title={`${m.label}${evaluation.commentaire ? ` — ${evaluation.commentaire}` : ''}`} className="inline-flex flex-shrink-0">
      <Icon className={cn('h-3.5 w-3.5', m.text)} />
    </span>
  )
}

function ExecutionsTab({ slug, onOpenRun }: { slug: string; onOpenRun: (id: string) => void }) {
  const [filtre, setFiltre] = useState('tout')
  const query = RUN_FILTERS.find((f) => f.key === filtre)?.query ?? ''
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-runs', slug, filtre],
    queryFn: () => apiFetch<{ total: number; runs: RunLigne[] }>(`/agents-ia/${slug}/runs${query}`),
    refetchInterval: 30_000,
  })

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {RUN_FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
            className={cn('px-3 py-1 text-xs rounded-md transition-colors',
              filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
            {f.label}
          </button>
        ))}
        {data && <span className="ml-auto text-xs text-muted-foreground">{data.total} exécution{data.total !== 1 ? 's' : ''}</span>}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Chargement impossible</p></div>
      : !data || data.runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Inbox className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">Aucune exécution</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '19%' }} /><col style={{ width: '17%' }} /><col style={{ width: '11%' }} />
              <col style={{ width: '10%' }} /><col style={{ width: '29%' }} /><col style={{ width: '14%' }} />
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                <th className="px-3 py-2.5 text-left font-semibold">BL</th>
                <th className="px-3 py-2.5 text-left font-semibold">Cde</th>
                <th className="px-3 py-2.5 text-right font-semibold">Pc</th>
                <th className="px-3 py-2.5 text-left font-semibold">Statut</th>
                <th className="px-3 py-2.5 text-right font-semibold">Coût</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} onClick={() => onOpenRun(r.id)} title={r.resume}
                  className="border-b border-border/40 last:border-b-0 cursor-pointer hover:bg-accent/5 transition-colors">
                  <td className="px-3 py-1.5">
                    <div className="tabular-nums truncate">{fmtDateCourte(r.createdAt)}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {SOURCE_LABEL[r.source]}{r.mode === 'essai' && r.source !== 'essai_manuel' ? ' · essai' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 truncate font-medium tabular-nums">{r.bordereau || '—'}</td>
                  <td className="px-3 py-1.5 truncate tabular-nums">{r.commande || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.nbPieces ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1 max-w-full">
                      <StatutPill statut={r.statut} />
                      <NoteIcon evaluation={r.evaluation} />
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">{fmtEur(r.coutUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── Retours (what the next version is written from) ──────

const RETOUR_FILTERS: Array<{ key: 'a_revoir' | 'tout'; label: string }> = [
  { key: 'a_revoir', label: 'À prendre en compte' },
  { key: 'tout', label: 'Tous' },
]

function RetoursTab({ agent, onOpenRun }: { agent: AgentDetail; onOpenRun: (id: string) => void }) {
  const [version, setVersion] = useState(agent.activeVersion)
  const [filtre, setFiltre] = useState<'a_revoir' | 'tout'>('a_revoir')
  useEffect(() => { setVersion(agent.activeVersion) }, [agent.slug, agent.activeVersion])
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-retours', agent.slug, version],
    queryFn: () => apiFetch<{ version: number; retours: Retour[]; resolutions?: RetourResolution[] }>(`/agents-ia/${agent.slug}/retours?version=${version}`),
  })
  const tous = data?.retours ?? []
  const resolutions = data?.resolutions ?? []
  // « À prendre en compte » = what says something: every partielle or échec,
  // and a réussite only when someone bothered to comment it.
  const retours = filtre === 'tout' ? tous : tous.filter((r) => r.note !== 'reussite' || r.commentaire)
  const compte = (n: Note) => tous.filter((r) => r.note === n).length
  const versionOptions = agent.versions.map((v) => ({
    id: v.version,
    primary: `Version ${v.version}`,
    secondary: v.version === agent.activeVersion ? 'active' : undefined,
  }))

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PopoverSelect size="sm" widthClass="w-[190px]" hideEmpty options={versionOptions} value={version} onChange={(v) => { if (v) setVersion(v) }} />
        <div className="flex items-center gap-1">
          {RETOUR_FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
              className={cn('px-3 py-1 text-xs rounded-md transition-colors',
                filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {NOTE_ORDER.map((n) => {
            const m = NOTE_META[n]
            const Icon = m.icon
            return <span key={n} className={cn('inline-flex items-center gap-1 tabular-nums', m.text)} title={m.label}><Icon className="h-3.5 w-3.5" />{compte(n)}</span>
          })}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Chaque évaluation partielle ou en échec porte un commentaire : c’est la liste à relire avant de publier la version suivante du prompt.
        {agent.pointsEvaluables && ' Les points du rapport évalués un par un y figurent aussi.'}
      </p>
      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Chargement impossible</p></div>
      : retours.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <MessagesSquare className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">{tous.length === 0 ? 'Aucune évaluation sur cette version' : 'Rien à prendre en compte sur cette version'}</p>
        </div>
      ) : retours.map((r, i) => {
        const m = NOTE_META[r.note]
        const Icon = m.icon
        return (
          <div key={`${r.runId}-${r.portee}-${i}`} onClick={() => onOpenRun(r.runId)} title="Ouvrir l’exécution"
            className={cn('rounded-lg border border-l-4 border-border/60 bg-zinc-100/80 p-3 cursor-pointer hover:border-accent/40 transition-colors', m.border)}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 border', m.soft)}>
                  <Icon className={cn('h-3.5 w-3.5', m.text)} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" title={r.titre ?? undefined}>
                    {r.portee === 'point' ? r.titre : `Exécution du ${fmtDateCourte(r.runLe)}`}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {r.portee === 'point' ? `Point du rapport du ${fmtDateCourte(r.runLe)}` : r.titre} · {r.par.nom}, {fmtDateHeure(r.le)}
                  </p>
                </div>
              </div>
              <span className={cn('text-xs font-semibold flex-shrink-0', m.text)}>{m.label}</span>
            </div>
            {r.commentaire && (
              <div className="flex items-start gap-1.5 mt-2 ml-9">
                <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                <p className="text-sm whitespace-pre-wrap">{r.commentaire}</p>
              </div>
            )}
            {r.retrait && <p className="text-[11px] text-muted-foreground mt-1 ml-9">{r.retrait}</p>}
          </div>
        )
      })}
      {!isLoading && !isError && resolutions.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-2">
            Marqués résolus à la main ({resolutions.length}) — ce que l’agent ne pouvait pas voir
          </p>
          {resolutions.map((r, i) => (
            <div key={`${r.runId}-res-${i}`} onClick={() => onOpenRun(r.runId)} title="Ouvrir le rapport"
              className="rounded-lg border-l-4 border border-border/60 border-l-green-500/60 bg-zinc-100/80 p-3 cursor-pointer hover:border-accent/40 transition-colors">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-green-500/10">
                  <CheckCheck className="h-3.5 w-3.5 text-green-700" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" title={r.titre}>{r.titre}</p>
                  <p className="text-[11px] text-muted-foreground truncate">Point du rapport du {fmtDateCourte(r.runLe)} · {r.par.nom}, {fmtDateHeure(r.le)}</p>
                </div>
              </div>
              <div className="flex items-start gap-1.5 mt-2 ml-9">
                <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                <p className="text-sm whitespace-pre-wrap">{r.commentaire}</p>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  )
}

// ── Prompt (versions) ────────────────────────────────────

function PromptTab({ agent, canPilot, onChanged }: { agent: AgentDetail; canPilot: boolean; onChanged: () => void }) {
  const [draftOpen, setDraftOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = agent.versions.find((v) => v.version === agent.activeVersion) ?? agent.versions[0]
  const activerMut = useMutation({
    mutationFn: (version: number) => callApi(`/agents-ia/${agent.slug}/versions/${version}/activer`, { method: 'POST' }),
    onSuccess: () => { setError(null); onChanged() },
    onError: (e: Error) => setError(e.message),
  })
  const livre = agent.promptLivre ?? null
  const [voirLivre, setVoirLivre] = useState(false)
  const [confirmLivre, setConfirmLivre] = useState(false)
  const prochaine = Math.max(0, ...agent.versions.map((v) => v.version)) + 1
  const publierLivreMut = useMutation({
    mutationFn: () => callApi(`/agents-ia/${agent.slug}/versions`, { method: 'POST', body: JSON.stringify(livre) }),
    onSuccess: () => { setError(null); setConfirmLivre(false); onChanged() },
    onError: (e: Error) => { setConfirmLivre(false); setError(e.message) },
  })

  return (
    <>
      {livre && (
        <div className="rounded-lg border-l-4 border border-border/60 border-l-amber-400/60 bg-amber-500/[0.06] p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
              <Upload className="h-3.5 w-3.5 text-amber-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Nouvelle version livrée avec l’application</p>
              <p className="text-[11px] text-muted-foreground">{livre.note}</p>
            </div>
            <button type="button" onClick={() => setVoirLivre((v) => !v)} className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors">
              {voirLivre ? 'Masquer le prompt' : 'Voir le prompt'}
            </button>
            <Button size="sm" className="flex-shrink-0" disabled={!canPilot || publierLivreMut.isPending} onClick={() => setConfirmLivre(true)}
              title={canPilot ? `Publier et activer la version ${prochaine}` : 'Droit « Piloter les agents IA » requis'}>
              {publierLivreMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}Publier la v{prochaine}
            </Button>
          </div>
          {voirLivre && <pre className="mt-2 text-xs whitespace-pre-wrap font-mono bg-white/70 rounded-md p-3 max-h-[40vh] overflow-auto scrollbar-transparent">{livre.prompt}</pre>}
        </div>
      )}
      <ConfirmDialog
        open={confirmLivre}
        variant="default"
        title={`Publier la version ${prochaine}`}
        description="Elle devient la version active dès maintenant et son score repart de zéro. La version actuelle reste dans l’historique et peut être réactivée."
        confirmLabel="Publier"
        isPending={publierLivreMut.isPending}
        onCancel={() => setConfirmLivre(false)}
        onConfirm={() => publierLivreMut.mutate()}
      />
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2">
          <ScrollText className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Version active — v{active.version}</h3>
          <Badge variant="secondary" className="text-[10px] py-0">{agent.modeles.find((m) => m.id === active.model)?.label ?? active.model}</Badge>
          <Button variant="outline" size="sm" className="ml-auto" disabled={!canPilot} onClick={() => setDraftOpen(true)}
            title={canPilot ? 'Publier une nouvelle version du prompt' : 'Droit « Piloter les agents IA » requis'}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />Nouvelle version
          </Button>
        </div>
        {active.note && <p className="text-xs text-muted-foreground italic mb-2">{active.note}</p>}
        <pre className="text-xs whitespace-pre-wrap font-mono bg-zinc-100/80 rounded-md p-3 max-h-[45vh] overflow-auto scrollbar-transparent">{active.prompt}</pre>
      </div>
      {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>}
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-1">Historique</p>
      {agent.versions.map((v) => {
        const isActive = v.version === agent.activeVersion
        return (
          <div key={v.version} className={cn('group rounded-lg border border-l-4 border-border/60 bg-zinc-100/80 p-3',
            isActive ? 'border-l-green-500/60' : 'border-l-border')}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', isActive ? 'bg-green-500/10' : 'bg-muted')}>
                  <ScrollText className={cn('h-3.5 w-3.5', isActive ? 'text-green-600' : 'text-muted-foreground')} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">Version {v.version} · {agent.modeles.find((m) => m.id === v.model)?.label ?? v.model}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {v.createdBy ? `${v.createdBy.nom} · ${fmtDateHeure(v.createdAt)}` : 'Version d’origine'}
                  </p>
                </div>
              </div>
              {isActive ? (
                <Badge variant="success" className="text-[10px] py-0">Active</Badge>
              ) : canPilot && (
                <Button variant="ghost" size="sm" className="h-7 text-accent hover:text-accent hover:bg-accent/10"
                  disabled={activerMut.isPending} onClick={() => activerMut.mutate(v.version)}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />Réactiver
                </Button>
              )}
            </div>
            {v.note && (
              <div className="flex items-start gap-1.5 mt-2 ml-9">
                <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-muted-foreground italic">{v.note}</p>
              </div>
            )}
          </div>
        )
      })}
      <NouvelleVersionDialog open={draftOpen} agent={agent} base={active} onClose={() => setDraftOpen(false)}
        onDone={() => { setDraftOpen(false); onChanged() }} />
    </>
  )
}

function NouvelleVersionDialog({ open, agent, base, onClose, onDone }: {
  open: boolean; agent: AgentDetail; base: AgentVersion; onClose: () => void; onDone: () => void
}) {
  const [prompt, setPrompt] = useState(base.prompt)
  const [model, setModel] = useState(base.model)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) { setPrompt(base.prompt); setModel(base.model); setNote(''); setError(null) }
  }, [open, base])
  const mut = useMutation({
    mutationFn: () => callApi(`/agents-ia/${agent.slug}/versions`, { method: 'POST', body: JSON.stringify({ prompt, model, note }) }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  })
  // What people said about the version being replaced — the reason to write a new one.
  const { data: retoursData } = useQuery({
    queryKey: ['agent-ia-retours', agent.slug, base.version],
    queryFn: () => apiFetch<{ retours: Retour[] }>(`/agents-ia/${agent.slug}/retours?version=${base.version}`),
    enabled: open,
  })
  const aPrendre = (retoursData?.retours ?? []).filter((r) => r.note !== 'reussite' || r.commentaire)
  const modelOptions = agent.modeles.map((m, i) => ({ id: i + 1, primary: m.label, secondary: m.id }))
  const unchanged = prompt.trim() === base.prompt.trim() && model === base.model

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl max-h-[90dvh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ScrollText className="h-5 w-5 text-accent" />Nouvelle version du prompt</DialogTitle>
        </DialogHeader>
        <div className="mt-4 flex-1 min-h-0 flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Modèle</label>
              <PopoverSelect options={modelOptions} hideEmpty
                value={Math.max(1, agent.modeles.findIndex((m) => m.id === model) + 1)}
                onChange={(id) => setModel(agent.modeles[id - 1]?.id ?? model)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Note (ce qui change et pourquoi)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>
          <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-2.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <MessagesSquare className="h-3.5 w-3.5" />Retours sur la version {base.version} ({aPrendre.length})
            </p>
            {aPrendre.length === 0 ? (
              <p className="text-xs text-muted-foreground italic mt-1">Aucun retour à prendre en compte.</p>
            ) : (
              <ul className="mt-1.5 max-h-36 overflow-y-auto space-y-1 scrollbar-transparent">
                {aPrendre.map((r, i) => {
                  const m = NOTE_META[r.note]
                  const Icon = m.icon
                  return (
                    <li key={`${r.runId}-${i}`} className="flex items-start gap-1.5 text-xs">
                      <Icon className={cn('h-3.5 w-3.5 flex-shrink-0 mt-px', m.text)} />
                      <span className="min-w-0">
                        {r.portee === 'point' && <span className="font-medium">{r.titre} — </span>}
                        {r.commentaire || <span className="italic text-muted-foreground">sans commentaire</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <div className="flex-1 min-h-0 flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
              className="flex-1 min-h-[300px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none scrollbar-transparent" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            La nouvelle version devient active immédiatement ; les versions précédentes restent réactivables. Testez-la avec « Tester un PDF » avant de la laisser en service.
          </p>
          {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || unchanged || prompt.trim().length < 20}
            title={unchanged ? 'Rien n’a changé par rapport à la version active' : undefined}>
            {mut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Publier la version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Coûts ────────────────────────────────────────────────

function CoutsTab({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ia-couts', slug],
    queryFn: () => apiFetch<Couts>(`/agents-ia/${slug}/couts?jours=30`),
  })
  if (isLoading || !data) return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
  const jours = data.parJour.filter((j) => j.runs > 0).reverse()
  return (
    <>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-1.5">
        <div className="flex items-center gap-2 mb-1"><CircleDollarSign className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">30 derniers jours</h3></div>
        <KV label="Coût total" value={fmtEur(data.totalUsd)} mono />
        <KV label="Exécutions" value={fmtNum(data.runs)} mono />
        <KV label="Coût moyen par exécution" value={fmtEur(data.moyenneUsd)} mono />
        <p className="text-[11px] text-muted-foreground pt-1">Estimation d’après le tarif public Mistral (OCR + modèle) — la facture fait foi.</p>
      </div>
      {jours.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucune exécution sur la période.</p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Jour</th>
                <th className="px-3 py-2.5 text-right font-semibold">Exécutions</th>
                <th className="px-3 py-2.5 text-right font-semibold">Coût</th>
              </tr>
            </thead>
            <tbody>
              {jours.map((j) => (
                <tr key={j.jour} className="border-b border-border/40 last:border-b-0">
                  <td className="px-3 py-2 tabular-nums">{new Date(j.jour).toLocaleDateString('fr-FR')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{j.runs}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtEur(j.coutUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── Fonctionnement ───────────────────────────────────────

function FonctionnementTab({ agent }: { agent: AgentDetail }) {
  return (
    <>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2"><Info className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Rôle</h3></div>
        <p className="text-sm text-muted-foreground">{agent.description}</p>
      </div>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2">
          {agent.declenchement.type === 'quotidien' ? <Clock className="h-4 w-4 text-accent" /> : <Mail className="h-4 w-4 text-accent" />}
          <h3 className="text-sm font-semibold">Déclenchement</h3>
        </div>
        <p className="text-sm text-muted-foreground">{agent.declencheur}</p>
        {agent.declenchement.type === 'releve' && (
          <p className="text-xs text-muted-foreground mt-1">
            Seuls les mails reçus après la première mise en marche sont lus
            {agent.startedAt ? ` (depuis le ${fmtDateHeure(agent.startedAt)})` : ''}.
          </p>
        )}
      </div>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2"><Play className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">{agent.declenchement.type === 'quotidien' ? 'Ce qu’il fait (en service)' : 'Ce qu’il enregistre (en service)'}</h3></div>
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
          {agent.ecritures.map((e) => <li key={e}>{e}</li>)}
        </ul>
      </div>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2"><AlertTriangle className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Quand il s’abstient</h3></div>
        <p className="text-sm text-muted-foreground">{agent.abstention}</p>
      </div>
      {agent.controles.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-2"><ShieldCheck className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Contrôles ({agent.controles.length})</h3></div>
          <ul className="space-y-2">
            {agent.controles.map((c) => (
              <li key={c.id}>
                <p className="text-sm font-medium">{c.libelle}</p>
                <p className="text-xs text-muted-foreground">{c.description}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

// ── Right sidebar ────────────────────────────────────────

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}

/** « Réussites / partielles / échecs » of the active version, then what is left to score. */
function EvaluationsKV({ s }: { s: AgentVue['stats'] }) {
  const e = s.evaluations
  return (
    <>
      <KV label="Réussites / partielles / échecs" mono value={
        <>
          <span className={NOTE_META.reussite.text}>{fmtNum(e.reussite)}</span>{' / '}
          <span className={cn(e.partielle > 0 && 'font-semibold', NOTE_META.partielle.text)}>{fmtNum(e.partielle)}</span>{' / '}
          <span className={cn(e.echec > 0 && 'font-semibold', NOTE_META.echec.text)}>{fmtNum(e.echec)}</span>
        </>
      } />
      <KV label="À évaluer" value={fmtNum(e.aEvaluer)} mono />
    </>
  )
}

/** A point-scored agent's score: what its version raised, and how much of it
 *  was worth raising. */
function PointsKV({ p }: { p: ScorePoints }) {
  const pct = p.precision === null ? null : Math.round(p.precision * 100)
  const tone = pct === null ? 'text-muted-foreground' : pct >= 80 ? NOTE_META.reussite.text : pct >= 50 ? NOTE_META.partielle.text : NOTE_META.echec.text
  return (
    <>
      <KV label="Points signalés" value={fmtNum(p.points)} mono />
      <KV label="Confirmés / partiels / fausses alertes" mono value={
        <>
          <span className={NOTE_META.reussite.text}>{fmtNum(p.reussite)}</span>{' / '}
          <span className={cn(p.partielle > 0 && 'font-semibold', NOTE_META.partielle.text)}>{fmtNum(p.partielle)}</span>{' / '}
          <span className={cn(p.echec > 0 && 'font-semibold', NOTE_META.echec.text)}>{fmtNum(p.echec)}</span>
        </>
      } />
      <KV label="À évaluer" value={fmtNum(p.aEvaluer)} mono />
      <KV label="Précision" value={<span className={cn('font-semibold', tone)}>{pct === null ? '—' : `${fmtNum(pct)} %`}</span>} mono />
    </>
  )
}

function DetailSidebar({ agent, canPilot, onChangeMode, isChangingMode }: {
  agent: AgentDetail | null; canPilot: boolean; onChangeMode: (m: Mode) => void; isChangingMode: boolean
}) {
  if (!agent) {
    return (
      <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  const s = agent.stats
  const n = (k: Statut) => s.parStatut[k] ?? 0
  const quotidien = agent.declenchement.type === 'quotidien'
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
            <Info className="h-3.5 w-3.5" />Aperçu
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          {quotidien ? (
            <>
              <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Planification</p>
                <KV label="Prochain contrôle" value={agent.mode === 'off' ? 'agent à l’arrêt' : fmtDateHeure(agent.prochaineExecution)} />
                <KV label="Dernier contrôle" value={ilYA(s.dernierRun)} />
                {agent.sondage.derniereErreur && (
                  <div className="flex items-start gap-1.5 mt-1 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{agent.sondage.derniereErreur}</span>
                  </div>
                )}
              </div>
              <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><History className="h-3.5 w-3.5" />Version {agent.activeVersion} — rapports</p>
                <KV label="Total" value={fmtNum(s.total)} mono />
                <KV label="Avec des points à voir" value={fmtNum(n('points_a_voir') + n('mail_envoye') + n('simule'))} mono />
                <KV label="Rien à signaler" value={fmtNum(n('rien_a_signaler'))} mono />
                <KV label="Erreurs" value={<span className={cn(n('erreur') > 0 && 'text-destructive font-semibold')}>{fmtNum(n('erreur'))}</span>} mono />
                <KV label="Coût" value={fmtEur(s.coutUsd)} mono />
              </div>
              {s.points && (
                <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><ListChecks className="h-3.5 w-3.5" />Version {agent.activeVersion} — points</p>
                  <PointsKV p={s.points} />
                  <p className="text-[11px] text-muted-foreground pt-1">Précision = points confirmés ou partiels sur points évalués. Les commentaires sont regroupés dans l’onglet Retours. Une nouvelle version repart de zéro.</p>
                </div>
              )}
            </>
          ) : (<>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Inbox className="h-3.5 w-3.5" />Boîte mail</p>
            <KV label="Dernier relevé" value={ilYA(agent.sondage.dernierSondage)} />
            <KV label="Dernier relevé réussi" value={ilYA(agent.sondage.dernierSucces)} />
            {agent.sondage.derniereErreur && (
              <div className="flex items-start gap-1.5 mt-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{agent.sondage.derniereErreur}</span>
              </div>
            )}
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><History className="h-3.5 w-3.5" />Version {agent.activeVersion} — exécutions</p>
            <KV label="Total" value={fmtNum(s.total)} mono />
            <KV label="Enregistrées" value={fmtNum(n('ecrit'))} mono />
            <KV label="Simulées (essai)" value={fmtNum(n('simule'))} mono />
            <KV label="Déjà importées" value={fmtNum(n('deja_importe'))} mono />
            <KV label="À vérifier" value={<span className={cn(n('a_verifier') > 0 && 'text-destructive font-semibold')}>{fmtNum(n('a_verifier'))}</span>} mono />
            <KV label="Erreurs" value={<span className={cn(n('erreur') > 0 && 'text-destructive font-semibold')}>{fmtNum(n('erreur'))}</span>} mono />
            <EvaluationsKV s={s} />
            <KV label="Coût" value={fmtEur(s.coutUsd)} mono />
            <p className="text-[11px] text-muted-foreground pt-1">Les tests manuels ne comptent pas. Les commentaires sont regroupés dans l’onglet Retours. Une nouvelle version repart de zéro.</p>
          </div>
          </>)}
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Mode</p>
            <p className="text-sm">{agent.modes[agent.mode]}</p>
            {agent.modeChangedBy && (
              <p className="text-[11px] text-muted-foreground">Changé par {agent.modeChangedBy.nom} le {fmtDateHeure(agent.modeChangedAt)}</p>
            )}
          </div>
        </div>
      </div>
      <ModeFooter current={agent.mode} descriptions={agent.modes} onChange={onChangeMode} isChanging={isChangingMode} disabled={!canPilot} />
    </div>
  )
}

/** §29.4 multi-state status footer — the agent's mode. */
function ModeFooter({ current, descriptions, onChange, isChanging, disabled }: {
  current: Mode; descriptions: Partial<Record<Mode, string>>; onChange: (m: Mode) => void; isChanging: boolean; disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = MODE_META[current]
  const Icon = meta.icon
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        <button type="button" onClick={() => setMenuOpen((v) => !v)} disabled={disabled || isChanging}
          title={disabled ? 'Droit « Piloter les agents IA » requis' : 'Changer le mode'}
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors">
          {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
          Changer
        </button>
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {MODE_ORDER.filter((m) => descriptions[m]).map((m) => {
            const mm = MODE_META[m]
            const active = current === m
            const MIcon = mm.icon
            return (
              <button key={m} type="button" onClick={() => { if (!active) onChange(m); setMenuOpen(false) }}
                className={cn('w-full flex items-start gap-2 px-3 py-2 text-sm text-left transition-colors',
                  active ? 'bg-accent/10 text-accent cursor-default' : 'hover:bg-zinc-100')}>
                <MIcon className="h-4 w-4 mt-0.5" />
                <span className="flex-1">
                  <span className="block">{mm.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{descriptions[m]}</span>
                </span>
                {active && <CheckCircle2 className="h-4 w-4 ml-auto text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Scoring ──────────────────────────────────────────────
// One scale for every agent: réussite / partielle / échec. Réussite needs no
// comment; the other two do — the comment is what the next prompt version is
// written from (onglet Retours). What an échec removes is the agent's own
// business, so the panel only confirms it when the caller says it removes
// something (BL: the pre-filled pieces).

const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

function NoteButtons({ value, onChange, disabled, size = 'md', titles }: {
  value: Note | null; onChange: (n: Note) => void; disabled?: boolean; size?: 'sm' | 'md'
  titles?: Partial<Record<Note, string>>
}) {
  return (
    <div className="flex gap-1.5">
      {NOTE_ORDER.map((n) => {
        const m = NOTE_META[n]
        const Icon = m.icon
        const on = value === n
        return (
          <button key={n} type="button" disabled={disabled} onClick={() => onChange(n)} title={titles?.[n] ?? m.label} aria-pressed={on}
            className={cn('flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
              size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
              on ? cn(m.solid, 'text-white shadow-sm') : cn('bg-background border-input text-muted-foreground hover:text-foreground', m.hover))}>
            <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />{m.label}
          </button>
        )
      })}
    </div>
  )
}

/** « Comment noter ? » — a link under a run's score buttons (BL) that unfolds
 *  the agent's scoring guide inline. A Superviseur report has ONE such button
 *  at the top of the report, never one per point. */
function GuideNotationToggle({ guide, textes }: { guide: GuideNotation; textes: Record<Note, string> }) {
  const [ouvert, setOuvert] = useState(false)
  return (
    <div className="space-y-1.5">
      <button type="button" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-accent transition-colors">
        <CircleHelp className="h-3.5 w-3.5" />
        {ouvert ? 'Masquer le guide de notation' : 'Comment noter ?'}
      </button>
      {ouvert && <GuideNotationCard guide={guide} textes={textes} />}
    </div>
  )
}

function GuideNotationCard({ guide, textes }: { guide: GuideNotation; textes: Record<Note, string> }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-2">
      <p className="text-xs font-semibold">{guide.question}</p>
      {NOTE_ORDER.map((n) => {
        const m = NOTE_META[n]
        const Icon = m.icon
        return (
          <div key={n} className={cn('rounded-md border border-l-4 border-border/60 px-2.5 py-1.5', m.border, m.soft)}>
            <p className={cn('text-xs font-semibold inline-flex items-center gap-1', m.text)}><Icon className="h-3.5 w-3.5" />{m.label}</p>
            <p className="text-xs mt-0.5">{textes[n]}</p>
            <p className="text-[11px] text-muted-foreground italic mt-0.5">Ex. : {guide.exemples[n]}</p>
          </div>
        )
      })}
      {guide.remarques.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-muted-foreground">
          {guide.remarques.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  )
}

/** Score a whole run. */
function EvaluationPanel({ evaluation, textes, guide, canEvaluate, confirmEchec, onSave, isPending, error, titre }: {
  evaluation: Evaluation | null | undefined
  textes: Record<Note, string>
  guide: GuideNotation
  canEvaluate: boolean
  /** Text of the confirmation shown before an échec that removes something; null = none. */
  confirmEchec: string | null
  onSave: (note: Note | null, commentaire: string) => void
  isPending: boolean
  error: string | null
  titre: string
}) {
  const [note, setNote] = useState<Note | null>(evaluation?.note ?? null)
  const [commentaire, setCommentaire] = useState(evaluation?.commentaire ?? '')
  const [confirmOpen, setConfirmOpen] = useState(false)
  useEffect(() => { setNote(evaluation?.note ?? null); setCommentaire(evaluation?.commentaire ?? '') }, [evaluation?.le, evaluation?.note, evaluation?.commentaire])
  // Close the confirmation once the save it guarded has gone through.
  useEffect(() => { if (!isPending) setConfirmOpen(false) }, [isPending])

  const texte = commentaire.trim()
  const manqueCommentaire = note !== null && note !== 'reussite' && !texte
  const inchange = note === (evaluation?.note ?? null) && texte === (evaluation?.commentaire ?? '')
  const enregistrer = () => {
    if (note === 'echec' && confirmEchec && evaluation?.note !== 'echec') setConfirmOpen(true)
    else onSave(note, texte)
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-2">
      <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" />{titre}</p>
      {!canEvaluate ? (
        evaluation ? <EvaluationLue evaluation={evaluation} /> : <p className="text-xs text-muted-foreground italic">Pas encore évaluée — droit « Évaluer les agents IA » requis pour le faire.</p>
      ) : (
        <>
          <NoteButtons value={note} onChange={setNote} disabled={isPending} titles={textes} />
          {note && <p className="text-[11px] text-muted-foreground">{textes[note]}</p>}
          <GuideNotationToggle guide={guide} textes={textes} />
          {note && (
            <textarea value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={2} maxLength={2000}
              placeholder={note === 'reussite' ? 'Commentaire (facultatif)' : 'Qu’est-ce qui n’allait pas ? (obligatoire — c’est ce qui sert à améliorer l’agent)'}
              className={textareaClass} />
          )}
          {evaluation && (
            <p className="text-[11px] text-muted-foreground">
              Évaluée « {NOTE_META[evaluation.note].label.toLowerCase()} » par {evaluation.par.nom}, {fmtDateHeure(evaluation.le)}
            </p>
          )}
          <div className="flex items-center gap-2">
            <div className="ml-auto flex items-center gap-2 flex-shrink-0">
              {evaluation && (
                <Button variant="ghost" size="sm" disabled={isPending} onClick={() => onSave(null, '')} title="Retirer l’évaluation (ce qu’un échec a retiré n’est pas remis)">
                  Effacer
                </Button>
              )}
              <Button size="sm" disabled={isPending || !note || manqueCommentaire || inchange} onClick={enregistrer}
                title={manqueCommentaire ? 'Un commentaire est obligatoire pour une évaluation partielle ou en échec' : undefined}>
                {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Enregistrer
              </Button>
            </div>
          </div>
          {evaluation?.retrait && <p className="text-[11px] text-muted-foreground">{evaluation.retrait}</p>}
        </>
      )}
      {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 flex-shrink-0" />{error}</div>}
      <ConfirmDialog open={confirmOpen} title="Évaluer en échec" description={confirmEchec ?? undefined} confirmLabel="Évaluer en échec"
        isPending={isPending} onCancel={() => setConfirmOpen(false)} onConfirm={() => onSave(note, texte)} />
    </div>
  )
}

/** A score, read-only: pill, comment, who and when. */
function EvaluationLue({ evaluation, className }: { evaluation: Pick<Evaluation, 'note' | 'commentaire' | 'par' | 'le'> & { retrait?: string | null }; className?: string }) {
  return (
    <div className={cn('space-y-0.5', className)}>
      <NotePill evaluation={evaluation as Evaluation} />
      {evaluation.commentaire && <p className="text-sm whitespace-pre-wrap">{evaluation.commentaire}</p>}
      <p className="text-[11px] text-muted-foreground">{evaluation.par.nom}, {fmtDateHeure(evaluation.le)}</p>
      {evaluation.retrait && <p className="text-[11px] text-muted-foreground">{evaluation.retrait}</p>}
    </div>
  )
}

/** Score one point of a Superviseur report, inside its card. Réussite saves
 *  in one click; partielle and échec open a comment first. */
function PointEvaluation({ avis, herite, textes, canEvaluate, onSave, isPending, className = 'mt-2 ml-9' }: {
  /** The score given on THIS report. */
  avis: Evaluation | undefined
  /** A score given on an earlier report, carried forward. */
  herite: ConstatRun['avis']
  /** What each score means for a point (the agent's `evaluation` texts). */
  textes: Record<Note, string>
  canEvaluate: boolean
  onSave: (note: Note | null, commentaire: string) => Promise<unknown>
  isPending: boolean
  className?: string
}) {
  const [brouillon, setBrouillon] = useState<Note | null>(null)
  const [commentaire, setCommentaire] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  // A scored point shows its score alone; the three buttons come back on « Modifier ».
  const [modif, setModif] = useState(false)
  const actuel = avis ?? null
  useEffect(() => { setModif(false); setBrouillon(null) }, [actuel?.le, herite?.le])
  const choisir = (n: Note) => {
    setErreur(null)
    if (n === 'reussite') { setBrouillon(null); onSave('reussite', '').catch((e: Error) => setErreur(e.message)); return }
    setBrouillon(n)
    setCommentaire(actuel?.note === n ? actuel.commentaire : '')
  }
  const valider = () => {
    if (!brouillon) return
    onSave(brouillon, commentaire.trim())
      .then(() => setBrouillon(null))
      .catch((e: Error) => setErreur(e.message))
  }
  const decide = actuel !== null || herite !== undefined
  const boutons = canEvaluate && (!decide || modif || brouillon !== null)

  return (
    <div className={cn('space-y-1.5', className)} onClick={(e) => e.stopPropagation()}>
      {actuel && !brouillon && (
        <div className="flex items-start gap-1.5 text-xs">
          <NotePill evaluation={actuel} className="flex-shrink-0" />
          <span className="min-w-0 text-muted-foreground">
            {actuel.commentaire && <span className="text-foreground">{actuel.commentaire} </span>}
            — {actuel.par.nom}, {fmtDateHeure(actuel.le)}
          </span>
          {canEvaluate && !modif && (
            <button type="button" className="flex-shrink-0 text-[11px] text-muted-foreground hover:text-accent transition-colors" disabled={isPending} onClick={() => setModif(true)}>
              Modifier
            </button>
          )}
        </div>
      )}
      {!actuel && herite && !brouillon && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0">
            Évalué {NOTE_META[herite.note].label.toLowerCase()} sur un rapport précédent par {herite.par.nom}{herite.commentaire ? ` : « ${herite.commentaire} »` : ''}
          </span>
          {canEvaluate && !modif && (
            <button type="button" className="flex-shrink-0 hover:text-accent transition-colors" disabled={isPending} onClick={() => setModif(true)}>
              Réévaluer
            </button>
          )}
        </div>
      )}
      {boutons && (
        <div className="max-w-md">
          <NoteButtons size="sm" value={brouillon ?? actuel?.note ?? null} onChange={choisir} disabled={isPending} titles={textes} />
        </div>
      )}
      {brouillon && (
        <div className="space-y-1.5 max-w-xl">
          <p className="text-[11px] text-muted-foreground">{textes[brouillon]}</p>
          <textarea value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={2} maxLength={2000} autoFocus
            placeholder="Qu’est-ce qui ne va pas ? (obligatoire)" className={textareaClass} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setBrouillon(null); setErreur(null) }}>Annuler</Button>
            <Button size="sm" disabled={isPending || !commentaire.trim()} onClick={valider}>
              {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Enregistrer
            </Button>
          </div>
        </div>
      )}
      {canEvaluate && actuel && modif && !brouillon && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <button type="button" className="hover:text-foreground transition-colors" disabled={isPending} onClick={() => setModif(false)}>Annuler</button>
          <button type="button" className="hover:text-destructive transition-colors" disabled={isPending}
            onClick={() => onSave(null, '').catch((e: Error) => setErreur(e.message))}>
            Effacer l’évaluation
          </button>
        </div>
      )}
      {erreur && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{erreur}</p>}
    </div>
  )
}

// ── Run dialog (side-by-side §18.C) ──────────────────────

const PIECE_STATUT: Record<PieceResolue['statut'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'text-success' },
  affectee_ailleurs: { label: 'Autre commande', cls: 'text-destructive' },
  inconnue: { label: 'Introuvable', cls: 'text-destructive' },
}

function RunDialog({ agent, runId, canPilot, canEvaluate, onClose, onOpenRun, onChanged }: {
  agent: AgentDetail; runId: string | null; canPilot: boolean; canEvaluate: boolean; onClose: () => void
  onOpenRun: (id: string) => void; onChanged: () => void
}) {
  const slug = agent.slug
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const [showOcr, setShowOcr] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)
  useEffect(() => { setPage(0); setShowOcr(false); setError(null); setEvalError(null) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunComplet>(`/agents-ia/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })

  const retraiterMut = useMutation({
    mutationFn: () => callApi<{ runs: RunLigne[] }>(`/agents-ia/${slug}/runs/${runId}/retraiter`, { method: 'POST' }),
    onSuccess: (r) => { onChanged(); if (r.runs[0]) onOpenRun(r.runs[0].id) },
    onError: (e: Error) => setError(e.message),
  })
  const evaluationMut = useMutation({
    mutationFn: (v: { note: Note | null; commentaire: string }) =>
      callApi(`/agents-ia/${slug}/runs/${runId}/evaluation`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => { setEvalError(null); onChanged(); queryClient.invalidateQueries({ queryKey: ['agent-ia-run', slug, runId] }) },
    onError: (e: Error) => setEvalError(e.message),
  })
  // An échec takes back the pieces this BL pre-filled — only while they are there.
  const ecriture = run?.resultat.ecriture ?? null
  const confirmEchec = run?.statut === 'ecrit' && ecriture && !ecriture.retire
    ? `Les ${ecriture.lignesEcrites} pièce(s) pré-remplies par ce BL seront retirées de la réception : le dialogue de réception ne les proposera plus. Le PDF reste dans les documents de la commande. « Retraiter » peut les réécrire.`
    : null

  const e = run?.resultat.extraction ?? null
  const res = run?.resultat.resolution ?? null
  const controles = run?.resultat.controles ?? []
  const statutPiece = (numero: string, i: number) => res?.pieces[i]?.numero_piece === numero ? res.pieces[i].statut : res?.pieces.find((p) => p.numero_piece === numero)?.statut
  const pdfUrl = run && run.fichiers.length > 0 ? `${API_URL}/agents-ia/${slug}/runs/${run.id}/fichiers/${page}#view=FitH` : null
  const somme = (k: 'poids' | 'metrage') => e ? e.pieces.reduce((s, p) => s + (p[k] ?? 0), 0) : 0

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-6xl w-[94vw] h-[88vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <FileText className="h-5 w-5 text-accent" />
            {e?.numero_bordereau ? `BL ${e.numero_bordereau}` : 'Exécution'}
            {run && <StatutPill statut={run.statut} className="text-xs py-0.5" />}
            {run && <span className="text-xs font-normal text-muted-foreground">{fmtDateHeure(run.createdAt)} · {SOURCE_LABEL[run.source]} · v{run.version}</span>}
          </DialogTitle>
        </DialogHeader>
        {isLoading || !run ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
        ) : (
          <div className="mt-4 flex-1 min-h-0 flex flex-col md:flex-row gap-4">
            {/* Left: what the agent read and decided */}
            <div className="md:w-[46%] flex-shrink-0 min-h-0 overflow-y-auto space-y-3 px-1 scrollbar-transparent">
              {run.message && (
                <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1">
                  <KV label="Mail" value={run.message.sujet || '—'} />
                  <KV label="De" value={run.message.de} />
                  <KV label="Reçu" value={fmtDateHeure(run.message.date)} />
                </div>
              )}
              {run.erreur && (
                <div className="rounded-lg border-l-4 border-l-destructive/60 border border-border/60 bg-destructive/5 p-3 text-sm text-destructive flex gap-2">
                  <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="break-words">{run.erreur}</span>
                </div>
              )}
              {controles.length > 0 && (
                <div className="space-y-1.5">
                  {controles.map((c, i) => (
                    <div key={i} className={cn('rounded-lg border border-l-4 border-border/60 p-2.5 text-sm flex gap-2',
                      c.gravite === 'bloquant' ? 'border-l-destructive/60 bg-destructive/5 text-destructive' : 'border-l-amber-400/60 bg-amber-400/10 text-amber-800')}>
                      {c.gravite === 'bloquant' ? <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                      <span>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {run.statut === 'ecrit' && ecriture && (
                ecriture.retire ? (
                  <div className="rounded-lg border-l-4 border-l-border border border-border/60 bg-zinc-100/80 p-3 text-sm text-muted-foreground flex gap-2">
                    <EyeOff className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>{ecriture.lignesEcrites} pièce(s) enregistrée(s), puis retirée(s) de la réception le {fmtDateHeure(ecriture.retire.le)} (évaluation en échec). Le PDF reste dans les documents de la commande.</span>
                  </div>
                ) : (
                  <div className="rounded-lg border-l-4 border-l-green-500/60 border border-border/60 bg-green-500/5 p-3 text-sm text-green-700 flex gap-2">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>{ecriture.lignesEcrites} pièce(s) enregistrée(s) pour la réception{ecriture.gedId ? ', PDF classé dans les documents de la commande' : ''}.</span>
                  </div>
                )
              )}
              {e && (
                <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1">
                  <KV label="Commande" value={e.numero_commande || '—'} mono />
                  <KV label="Ligne de commande" value={res?.ligneId ? `#${res.ligneId}${e.ligne ? ` (imprimé : ligne ${e.ligne})` : ''}` : '—'} mono />
                  <KV label="Lot" value={res?.lot || '—'} mono />
                  <KV label="Totaux imprimés" value={`${e.nombre_pieces ?? '—'} pc · ${e.poids_total != null ? fmtNum(e.poids_total, 2) : '—'} kg · ${e.metrage_total != null ? fmtNum(e.metrage_total, 2) : '—'} m`} mono />
                  <KV label="Totaux lus" value={`${e.pieces.length} pc · ${fmtNum(somme('poids'), 2)} kg · ${fmtNum(somme('metrage'), 2)} m`} mono />
                </div>
              )}
              {e && e.pieces.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                  <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                    <colgroup><col style={{ width: '27%' }} /><col style={{ width: '13%' }} /><col style={{ width: '14%' }} /><col style={{ width: '31%' }} /><col style={{ width: '15%' }} /></colgroup>
                    <thead className="bg-zinc-200/60 border-b border-border/60">
                      <tr className="uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-2 text-left font-semibold">Pièce</th>
                        <th className="px-2 py-2 text-right font-semibold">Kg</th>
                        <th className="px-2 py-2 text-right font-semibold">M</th>
                        <th className="px-2 py-2 text-left font-semibold">Observations</th>
                        <th className="px-2 py-2 text-left font-semibold">Stock</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.pieces.map((p, i) => {
                        const st = statutPiece(p.numero_piece, i)
                        return (
                          <tr key={`${p.numero_piece}-${i}`} className="border-b border-border/40 last:border-b-0">
                            <td className="px-2 py-1.5 truncate font-medium tabular-nums" title={p.numero_piece}>{p.numero_piece}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{p.poids != null ? fmtNum(p.poids, 2) : '—'}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{p.metrage != null ? fmtNum(p.metrage, 2) : '—'}</td>
                            <td className="px-2 py-1.5 truncate text-muted-foreground" title={p.observations}>{p.observations || '—'}</td>
                            <td className={cn('px-2 py-1.5 truncate', st ? PIECE_STATUT[st].cls : 'text-muted-foreground')}>{st ? PIECE_STATUT[st].label : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {(run.resultat.pages ?? []).some((p) => p.ocr) && (
                <div>
                  <button type="button" onClick={() => setShowOcr((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {showOcr ? 'Masquer le texte lu (OCR)' : 'Afficher le texte lu (OCR)'}
                  </button>
                  {showOcr && (
                    <pre className="mt-2 text-[11px] whitespace-pre-wrap font-mono bg-zinc-100/80 rounded-md p-3 max-h-80 overflow-auto scrollbar-transparent">
                      {(run.resultat.pages ?? []).map((p) => p.ocr ?? '').join('\n\n')}
                    </pre>
                  )}
                </div>
              )}
            </div>
            {/* Right: the PDF + actions */}
            <div className="flex-1 min-w-0 min-h-[300px] flex flex-col gap-2">
              {run.fichiers.length > 1 && (
                <div className="flex gap-1">
                  {run.fichiers.map((f, i) => (
                    <button key={i} type="button" onClick={() => setPage(i)} title={f.nom}
                      className={cn('px-3 py-1 text-xs rounded-md transition-colors', page === i ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
                      Page {i + 1}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
                {pdfUrl ? <iframe key={pdfUrl} src={pdfUrl} className="w-full h-full" title="BL" />
                : <div className="h-full flex flex-col items-center justify-center text-muted-foreground"><FileText className="h-12 w-12 opacity-30" /><p className="text-sm">Aucun PDF</p></div>}
              </div>
              <EvaluationPanel titre="Évaluer cette lecture" evaluation={run.evaluation} textes={agent.evaluation} guide={agent.guideNotation}
                canEvaluate={canEvaluate} confirmEchec={confirmEchec} isPending={evaluationMut.isPending} error={evalError}
                onSave={(note, commentaire) => evaluationMut.mutate({ note, commentaire })} />
              {canPilot && run.fichiers.length > 0 && (
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" disabled={retraiterMut.isPending} onClick={() => retraiterMut.mutate()}
                    title="Relancer la lecture avec la version active (enregistre si l’agent est en service)">
                    {retraiterMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />}Retraiter
                  </Button>
                </div>
              )}
              {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Superviseur (the morning report) ─────────────────────
// A run IS the report Isabelle reads each morning: the points to handle, each
// scored on its own (PointEvaluation — an échec sets the point aside in the
// next reports), then the run scored as a whole (EvaluationPanel).

type Gravite = 'info' | 'attention' | 'urgent'
interface ConstatRun {
  cle: string
  controle: string
  domaine: string
  gravite: Gravite
  titre: string
  message: string
  lien: string | null
  etat: 'nouveau' | 'aggrave' | 'ouvert'
  depuis: string
  /** A score given on an earlier report, carried forward by the agent. */
  avis?: { note: Note; commentaire: string; par: Auteur; le: string }
  /** Marked résolu on an earlier report, carried forward by the agent. */
  resolution?: Resolution
}
/** « Résolu » by a person, with why. */
interface Resolution { commentaire: string; par: Auteur; le: string }
interface ResultatSuperviseur {
  controles?: Array<{ id: string; libelle: string; domaine: string; nb: number; dureeMs: number; erreur: string | null }>
  constats?: ConstatRun[]
  /** Points scored « échec » (false alarm) on an earlier report. */
  ecartes?: ConstatRun[]
  /** Still returned by a check, but marked résolu by a person earlier. */
  resolus?: ConstatRun[]
  /** Closed by the agent: `raison` says why (absent before 2026-09-25). */
  fermes?: Array<{ cle: string; titre: string; domaine: string; depuis: string; raison?: string; resolution?: Resolution }>
  memoireMiseAJour?: boolean
}
interface RunSuperviseur extends Omit<RunLigne, 'bordereau' | 'commande' | 'nbPieces' | 'nbNouveaux' | 'nbOuverts' | 'nbFermes' | 'nbEcartes' | 'bilan'> {
  resultat: ResultatSuperviseur
  avisPoints?: Record<string, Evaluation>
  resolutionsPoints?: Record<string, Resolution>
}

const DOMAINE_LIBELLE: Record<string, string> = {
  mails: 'Mails clients', commandes_client: 'Commandes clients', devis: 'Devis', sous_traitants: 'Sous-traitants',
  fils: 'Fils', stock: 'Stock', references: 'Références', etudes_coloris: 'Études coloris', qualite: 'Qualité',
  integrite: 'Intégrité des données',
}

const GRAVITE_META: Record<Gravite, { border: string; iconBg: string; iconCls: string; icon: ComponentType<{ className?: string }> }> = {
  urgent: { border: 'border-l-destructive/60', iconBg: 'bg-destructive/10', iconCls: 'text-destructive/70', icon: AlertTriangle },
  attention: { border: 'border-l-amber-400/60', iconBg: 'bg-amber-400/10', iconCls: 'text-amber-600', icon: AlertCircle },
  info: { border: 'border-l-border', iconBg: 'bg-muted', iconCls: 'text-muted-foreground', icon: Info },
}

/** « 3 / 10 » points scored, then how — one icon per score present. */
function BilanCell({ b }: { b: BilanPoints | null }) {
  if (!b || b.points === 0) return <span className="text-muted-foreground">—</span>
  const fini = b.aEvaluer === 0
  return (
    <>
      <div className={cn('tabular-nums whitespace-nowrap', fini && 'font-semibold text-green-700')}>
        {fmtNum(b.evalues)}<span className="text-muted-foreground font-normal"> / {fmtNum(b.points)}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {b.evalues === 0
          ? <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />à évaluer</span>
          : NOTE_ORDER.filter((n) => b[n] > 0).map((n) => {
              const m = NOTE_META[n]
              const Icon = m.icon
              return <span key={n} className={cn('inline-flex items-center gap-0.5 tabular-nums', m.text)} title={m.label}><Icon className="h-3 w-3" />{fmtNum(b[n])}</span>
            })}
      </div>
    </>
  )
}

function joursDepuis(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

const SUP_FILTERS: Array<{ key: string; label: string; query: string }> = [
  { key: 'tout', label: 'Tous', query: '' },
  { key: 'a_evaluer', label: 'À évaluer', query: '?note=a_evaluer' },
  { key: 'mal', label: 'Partiels / échecs', query: '?note=partielle,echec' },
  { key: 'erreurs', label: 'Erreurs', query: '?statut=erreur' },
]

function SuperviseurExecutionsTab({ slug, onOpenRun }: { slug: string; onOpenRun: (id: string) => void }) {
  const [filtre, setFiltre] = useState('tout')
  const q = SUP_FILTERS.find((f) => f.key === filtre)?.query ?? ''
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-runs', slug, filtre],
    queryFn: () => apiFetch<{ total: number; runs: RunLigne[] }>(`/agents-ia/${slug}/runs${q}`),
    refetchInterval: 30_000,
  })
  const num = (v: number | null) => (v === null ? '—' : fmtNum(v))

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {SUP_FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
            className={cn('px-3 py-1 text-xs rounded-md transition-colors',
              filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
            {f.label}
          </button>
        ))}
        {data && <span className="ml-auto text-xs text-muted-foreground">{data.total} rapport{data.total !== 1 ? 's' : ''}</span>}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Chargement impossible</p></div>
      : !data || data.runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Inbox className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">Aucun rapport</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '19%' }} /><col style={{ width: '22%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} /><col style={{ width: '9%' }} /><col style={{ width: '20%' }} /><col style={{ width: '12%' }} />
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                <th className="px-3 py-2.5 text-left font-semibold">Résultat</th>
                <th className="px-3 py-2.5 text-right font-semibold" title="Points nouveaux ou aggravés">Nouv.</th>
                <th className="px-3 py-2.5 text-right font-semibold" title="Points toujours ouverts">Ouv.</th>
                <th className="px-3 py-2.5 text-right font-semibold" title="Points résolus depuis le rapport précédent">Rés.</th>
                <th className="px-3 py-2.5 text-left font-semibold" title="Points évalués sur points signalés">Évalués</th>
                <th className="px-3 py-2.5 text-right font-semibold">Coût</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} onClick={() => onOpenRun(r.id)} title={r.resume}
                  className="border-b border-border/40 last:border-b-0 cursor-pointer hover:bg-accent/5 transition-colors">
                  <td className="px-3 py-1.5">
                    <div className="tabular-nums truncate">{fmtDateCourte(r.createdAt)}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{SOURCE_LABEL[r.source]}</div>
                  </td>
                  <td className="px-3 py-1.5"><StatutPill statut={r.statut} /></td>
                  <td className={cn('px-3 py-1.5 text-right tabular-nums', (r.nbNouveaux ?? 0) > 0 && 'font-semibold text-amber-700')}>{num(r.nbNouveaux)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(r.nbOuverts)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(r.nbFermes)}</td>
                  <td className="px-3 py-1.5"><BilanCell b={r.bilan} /></td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">{fmtEur(r.coutUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function ConstatCard({ c, avis, resolution, textes, canEvaluate, onSave, onResolve, isPending, estompe }: {
  c: ConstatRun
  avis: Evaluation | undefined
  /** Marked résolu on THIS report (a carried one is `c.resolution`). */
  resolution: Resolution | undefined
  textes: Record<Note, string>
  canEvaluate: boolean
  onSave: (note: Note | null, commentaire: string) => Promise<unknown>
  /** Mark résolu with why, or undo it (null). */
  onResolve: (commentaire: string | null) => Promise<unknown>
  isPending: boolean
  /** Set aside (false alarm): shown quieter. */
  estompe?: boolean
}) {
  const [brouillon, setBrouillon] = useState<string | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  // A resolved point folds to its title + how it was settled; the detail
  // stays one click away.
  const [deplie, setDeplie] = useState(false)
  const res = resolution ?? c.resolution
  const replie = !!res && !deplie
  const g = GRAVITE_META[c.gravite]
  const Icon = res ? CheckCircle2 : g.icon
  const j = joursDepuis(c.depuis)
  const { contexte, action } = decouperMessage(c.message)
  const valider = () => {
    if (!brouillon?.trim()) return
    setErreur(null)
    onResolve(brouillon.trim()).then(() => setBrouillon(null)).catch((e: Error) => setErreur(e.message))
  }
  return (
    <div className={cn('rounded-lg border border-l-4 border-border/60 bg-card shadow-sm overflow-hidden',
      res ? 'border-l-green-500/60' : estompe ? 'border-l-border opacity-80' : g.border)}>
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div className={cn('h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0', res ? 'bg-green-500/10' : estompe ? 'bg-muted' : g.iconBg)}>
            <Icon className={cn('h-4 w-4', res ? 'text-green-600' : estompe ? 'text-muted-foreground' : g.iconCls)} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug line-clamp-2" title={c.titre}>{c.titre}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span>{DOMAINE_LIBELLE[c.domaine] ?? c.domaine}</span>
              {c.etat === 'nouveau' && <Badge variant="outline" className="text-[10px] py-0 border-amber-500/40 bg-amber-500/10 text-amber-800">Nouveau</Badge>}
              {c.etat === 'aggrave' && <Badge variant="outline" className="text-[10px] py-0 border-destructive/40 bg-destructive/10 text-destructive">Aggravé</Badge>}
              {c.etat === 'ouvert' && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap"><Clock className="h-3 w-3" />ouvert depuis {j === 0 ? 'aujourd’hui' : `${j} j`}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0 -mt-0.5">
            {res && (
              <button type="button" onClick={() => setDeplie((v) => !v)} title={deplie ? 'Replier' : 'Voir le détail'}
                className="h-7 w-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-zinc-100 transition-colors">
                <ChevronDown className={cn('h-4 w-4 transition-transform', deplie && 'rotate-180')} />
              </button>
            )}
            {c.lien && (
              <Link to={c.lien} title="Ouvrir dans ETM"
                className="h-7 w-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors">
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
        {!replie && (
          <div className="mt-2.5 ml-[42px] space-y-2">
            {contexte && <p className="text-[13px] leading-relaxed text-muted-foreground">{contexte}</p>}
            {action && (
              <div className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent/[0.07] px-2.5 py-1.5">
                <ArrowRight className="h-3.5 w-3.5 text-amber-700 flex-shrink-0 mt-[3px]" />
                <p className="text-[13px] leading-snug"><span className="font-semibold text-amber-800">À faire : </span>{action}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* What people did about it: how it was settled, its score, the two actions. */}
      <div className="border-t border-border/50 bg-zinc-50 px-3 py-2 space-y-1.5">
        {res && (
          <div className="flex items-start gap-1.5 text-xs">
            <CheckCheck className="h-3.5 w-3.5 text-green-700 flex-shrink-0 mt-px" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-green-700">Résolu{resolution ? '' : ' sur un rapport précédent'} : </span>
              <span>{res.commentaire}</span>
              <span className="text-muted-foreground"> — {res.par.nom}, {fmtDateHeure(res.le)}</span>
            </span>
            {canEvaluate && (
              <button type="button" className="flex-shrink-0 text-[11px] text-muted-foreground hover:text-destructive transition-colors" disabled={isPending}
                onClick={() => { setErreur(null); onResolve(null).catch((e: Error) => setErreur(e.message)) }}>
                Annuler
              </button>
            )}
          </div>
        )}
        <div className="flex items-start gap-3">
          {/* Folded résolu: its score (if any) still shows, the buttons wait for « Voir le détail ». */}
          <PointEvaluation avis={avis} herite={c.avis} textes={textes} canEvaluate={canEvaluate && !replie} onSave={onSave} isPending={isPending} className="min-w-0 flex-1" />
          {canEvaluate && !res && brouillon === null && (
            <button type="button" onClick={() => { setBrouillon(''); setErreur(null) }} disabled={isPending}
              title="Le problème est réglé (appel, accord avec le client…) : expliquez comment"
              className="flex-shrink-0 h-7 px-2.5 rounded-md border border-green-600/30 bg-white inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:bg-green-500/10 transition-colors">
              <CheckCheck className="h-3.5 w-3.5" />Marquer résolu
            </button>
          )}
        </div>
        {brouillon !== null && (
          <div className="space-y-1.5 max-w-xl pt-1">
            <p className="text-[11px] text-muted-foreground">
              Le point quitte la liste à traiter. Dites comment il a été réglé — l’agent s’en sert pour sa version suivante.
            </p>
            <textarea value={brouillon} onChange={(e) => setBrouillon(e.target.value)} rows={2} maxLength={2000} autoFocus
              placeholder="Ex. : PE a eu le client au téléphone (obligatoire)" className={textareaClass} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setBrouillon(null); setErreur(null) }}>Annuler</Button>
              <Button size="sm" disabled={isPending || !brouillon.trim()} onClick={valider}>
                {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5 mr-1.5" />}Marquer résolu
              </Button>
            </div>
          </div>
        )}
        {erreur && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{erreur}</p>}
      </div>
    </div>
  )
}

/** The mail check writes « <what happened> À faire : <action> » in one string:
 *  split it so the action stands out. Other checks have no action part. */
function decouperMessage(m: string): { contexte: string; action: string | null } {
  const i = m.search(/À faire\s*:/)
  if (i < 0) return { contexte: m.trim(), action: null }
  return { contexte: m.slice(0, i).trim(), action: m.slice(i).replace(/^À faire\s*:\s*/, '').trim() || null }
}

/** The report in figures, one strip across the top of the dialog. A figure
 *  takes a colour only when it carries a meaning (§18.D verdict rule, flat). */
function KpiStrip({ items }: {
  items: Array<{ key: string; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }>
}) {
  return (
    <div className="flex-shrink-0 grid grid-cols-3 md:grid-cols-6 gap-px rounded-lg border border-border/60 bg-border/60 overflow-hidden">
      {items.map((it) => (
        <div key={it.key} className="bg-zinc-100 px-3 py-2 min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate" title={it.label}>{it.label}</p>
          <p className={cn('text-2xl font-bold tabular-nums leading-tight', it.tone)}>{it.value}</p>
          <div className="mt-1 h-4 text-[11px] text-muted-foreground truncate">{it.sub}</div>
        </div>
      ))}
    </div>
  )
}

/** The report is the morning's batch of points: the KPIs say how it stands,
 *  each point is scored on its own — the report as a whole never is. */
function SuperviseurRunDialog({ agent, runId, canEvaluate, onClose, onChanged }: {
  agent: AgentDetail; runId: string | null; canEvaluate: boolean; onClose: () => void; onChanged: () => void
}) {
  const slug = agent.slug
  const queryClient = useQueryClient()
  const [showControles, setShowControles] = useState(false)
  // One scoring guide for the whole report, never one per point.
  const [showGuide, setShowGuide] = useState(false)
  const [showEcartes, setShowEcartes] = useState(false)
  useEffect(() => { setShowControles(false); setShowEcartes(false) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunSuperviseur>(`/agents-ia/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })
  const rafraichir = () => { onChanged(); queryClient.invalidateQueries({ queryKey: ['agent-ia-run', slug, runId] }) }

  const pointMut = useMutation({
    mutationFn: (v: { cle: string; note: Note | null; commentaire: string }) =>
      callApi(`/agents-ia/${slug}/runs/${runId}/points`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: rafraichir,
  })
  const resolutionMut = useMutation({
    mutationFn: (v: { cle: string; commentaire: string | null }) =>
      callApi(`/agents-ia/${slug}/runs/${runId}/points/resolution`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: rafraichir,
  })

  const res = run?.resultat
  const constats = res?.constats ?? []
  const ecartes = res?.ecartes ?? []
  const fermes = res?.fermes ?? []
  const resolusAvant = res?.resolus ?? []
  const controles = res?.controles ?? []
  const avis = run?.avisPoints ?? {}
  const resolutions = run?.resolutionsPoints ?? {}
  // A point marked résolu on this report leaves its section for « Résolus »,
  // with the ones closed since the previous report.
  const neufs = constats.filter((c) => c.etat !== 'ouvert' && !resolutions[c.cle])
  const ouverts = constats.filter((c) => c.etat === 'ouvert' && !resolutions[c.cle])
  const resolusRapport = constats.filter((c) => resolutions[c.cle])
  // A point scored on an earlier report counts as scored (score.ts, same rule as the list).
  const noteDe = (c: ConstatRun): Note | null => avis[c.cle]?.note ?? c.avis?.note ?? null
  const notes = constats.map(noteDe)
  const compte = (n: Note) => notes.filter((x) => x === n).length
  // Marked résolu here and not scored: dealt with, never « à évaluer » (score.ts bilanRun).
  const resolusIci = resolusRapport.length
  const aEvaluer = constats.filter((c) => noteDe(c) === null && !resolutions[c.cle]).length
  const nbResolus = fermes.length + resolusAvant.length + resolusIci
  const pct = constats.length ? Math.round(((constats.length - aEvaluer) / constats.length) * 100) : 0

  const carte = (c: ConstatRun, estompe = false) => (
    <ConstatCard key={c.cle} c={c} avis={avis[c.cle]} resolution={resolutions[c.cle]} textes={agent.evaluation} canEvaluate={canEvaluate} estompe={estompe}
      isPending={(pointMut.isPending && pointMut.variables?.cle === c.cle) || (resolutionMut.isPending && resolutionMut.variables?.cle === c.cle)}
      onSave={(note, commentaire) => pointMut.mutateAsync({ cle: c.cle, note, commentaire })}
      onResolve={(commentaire) => resolutionMut.mutateAsync({ cle: c.cle, commentaire })} />
  )

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl w-[94vw] h-[88vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <ShieldCheck className="h-5 w-5 text-accent" />
            {run ? `Rapport du ${fmtDateHeure(run.createdAt)}` : 'Rapport'}
            {run && <StatutPill statut={run.statut} className="text-xs py-0.5" />}
            {run && constats.length > 0 && (aEvaluer > 0
              ? <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"><Clock className="h-3.5 w-3.5" />À évaluer</span>
              : <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', NOTE_META.reussite.text)}><CheckCircle2 className="h-3.5 w-3.5" />Évalué</span>)}
            {run && (
              <span className="text-xs font-normal text-muted-foreground">
                {SOURCE_LABEL[run.source]} · v{run.version} · {fmtNum(run.dureeMs / 1000, 1)} s
              </span>
            )}
          </DialogTitle>
          {run && res && !res.memoireMiseAJour && (
            <p className="text-xs text-muted-foreground">Lancement manuel : la mémoire des points signalés n’a pas été modifiée.</p>
          )}
        </DialogHeader>
        {isLoading || !run ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
        ) : (
          <div className="mt-4 flex-1 min-h-0 flex flex-col gap-3">
            <KpiStrip items={[
              { key: 'signales', label: 'Points signalés', value: fmtNum(constats.length),
                sub: constats.length > 0 ? `${fmtNum(neufs.length)} nouveaux · ${fmtNum(ouverts.length)} ouverts` : 'rien à traiter' },
              { key: 'evalues', label: 'Évalués', tone: constats.length > 0 && aEvaluer === 0 ? NOTE_META.reussite.text : undefined,
                value: <>{fmtNum(constats.length - aEvaluer)}<span className="text-sm font-normal text-muted-foreground"> / {fmtNum(constats.length)}</span></>,
                sub: constats.length > 0 && (
                  <div className="h-1.5 mt-1 rounded-full bg-zinc-200 overflow-hidden" title={`${pct} %`}>
                    <div className={cn('h-full rounded-full transition-all', aEvaluer === 0 ? 'bg-success' : 'bg-accent')} style={{ width: `${pct}%` }} />
                  </div>
                ) },
              { key: 'reussite', label: 'Confirmés', value: fmtNum(compte('reussite')), tone: compte('reussite') > 0 ? NOTE_META.reussite.text : undefined },
              { key: 'partielle', label: 'Partiels', value: fmtNum(compte('partielle')), tone: compte('partielle') > 0 ? NOTE_META.partielle.text : undefined },
              { key: 'echec', label: 'Fausses alertes', value: fmtNum(compte('echec')), tone: compte('echec') > 0 ? NOTE_META.echec.text : undefined,
                sub: ecartes.length > 0 ? `${fmtNum(ecartes.length)} écartée${ecartes.length > 1 ? 's' : ''} avant` : undefined },
              { key: 'fermes', label: 'Résolus', value: fmtNum(nbResolus), tone: nbResolus > 0 ? NOTE_META.reussite.text : undefined,
                sub: `${fmtNum(fermes.length)} constatés · ${fmtNum(resolusAvant.length + resolusIci)} à la main` },
            ]} />

            <div className="flex-shrink-0 flex items-center justify-between gap-3 text-xs text-muted-foreground px-1">
              <div className="min-w-0 flex items-center gap-3">
                {constats.length > 0 && (
                  <button type="button" onClick={() => setShowGuide((v) => !v)} aria-expanded={showGuide}
                    className={cn('flex-shrink-0 inline-flex items-center gap-1 font-medium transition-colors', showGuide ? 'text-accent' : 'hover:text-accent')}>
                    <CircleHelp className="h-3.5 w-3.5" />{showGuide ? 'Masquer le guide de notation' : 'Comment noter ?'}
                  </button>
                )}
                <span className="min-w-0 truncate">
                  {constats.length === 0 ? ''
                    : !canEvaluate ? 'Droit « Évaluer les agents IA » requis pour noter les points.'
                    : aEvaluer > 0 ? ''
                    : 'Tous les points sont évalués.'}
                </span>
              </div>
              <button type="button" onClick={() => setShowControles((v) => !v)} className="flex-shrink-0 hover:text-foreground transition-colors">
                {showControles ? 'Masquer les contrôles exécutés' : `Afficher les contrôles exécutés (${controles.length})`}
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 px-1 pb-1 scrollbar-transparent">
              {showGuide && constats.length > 0 && <GuideNotationCard guide={agent.guideNotation} textes={agent.evaluation} />}
              {showControles && (
                controles.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">Aucun contrôle n’est encore en place.</p>
                ) : (
                  <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                    <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                      <colgroup><col style={{ width: '64%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /></colgroup>
                      <thead className="bg-zinc-200/60 border-b border-border/60">
                        <tr className="uppercase tracking-wide text-muted-foreground">
                          <th className="px-2 py-2 text-left font-semibold">Contrôle</th>
                          <th className="px-2 py-2 text-right font-semibold">Points</th>
                          <th className="px-2 py-2 text-right font-semibold">Durée</th>
                        </tr>
                      </thead>
                      <tbody>
                        {controles.map((c) => (
                          <tr key={c.id} className="border-b border-border/40 last:border-b-0" title={c.erreur ?? undefined}>
                            <td className={cn('px-2 py-1.5 truncate', c.erreur && 'text-destructive')}>{c.erreur && <XCircle className="h-3 w-3 inline mr-1" />}{c.libelle}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{c.erreur ? '—' : fmtNum(c.nb)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(c.dureeMs / 1000, 1)} s</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
              {run.erreur && (
                <div className="rounded-lg border-l-4 border-l-destructive/60 border border-border/60 bg-destructive/5 p-3 text-sm text-destructive flex gap-2">
                  <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="break-words">{run.erreur}</span>
                </div>
              )}
              {pointMut.error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{(pointMut.error as Error).message}</div>}

              {neufs.length > 0 && <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-1">Nouveaux points</p>}
              {neufs.map((c) => carte(c))}
              {ouverts.length > 0 && <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-1">Toujours ouverts</p>}
              {ouverts.map((c) => carte(c))}

              {neufs.length + ouverts.length === 0 && !run.erreur && (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <CheckCircle2 className="h-10 w-10 mb-2 opacity-40" />
                  <p className="text-sm">Aucun point à traiter</p>
                </div>
              )}

              {nbResolus > 0 && <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold pt-1">Résolus</p>}
              {resolusRapport.map((c) => carte(c))}
              {fermes.map((f) => (
                <div key={f.cle} className="rounded-lg border-l-4 border border-border/60 border-l-green-500/60 bg-card shadow-sm p-2.5">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />
                    <span className="text-sm truncate flex-1" title={f.titre}>{f.titre}</span>
                    <span className="text-[11px] text-muted-foreground flex-shrink-0">{DOMAINE_LIBELLE[f.domaine] ?? f.domaine}</span>
                  </div>
                  {f.raison && <p className="text-xs text-muted-foreground mt-1 ml-[22px]">{f.raison}</p>}
                  {f.resolution && (
                    <p className="text-xs mt-0.5 ml-[22px]">
                      <span className="font-semibold text-green-700">Marqué résolu : </span>{f.resolution.commentaire}
                      <span className="text-muted-foreground"> — {f.resolution.par.nom}</span>
                    </p>
                  )}
                </div>
              ))}
              {resolusAvant.map((c) => carte(c))}

              {ecartes.length > 0 && (
                <div className="pt-1">
                  <button type="button" onClick={() => setShowEcartes((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                    <EyeOff className="h-3.5 w-3.5" />
                    {showEcartes ? 'Masquer les points écartés' : `Afficher les points écartés — fausses alertes (${ecartes.length})`}
                  </button>
                  {showEcartes && <div className="mt-2 space-y-2">{ecartes.map((c) => carte(c, true))}</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Manual test dialog ───────────────────────────────────

function EssaiDialog({ open, slug, onClose, onDone }: {
  open: boolean; slug: string; onClose: () => void; onDone: (runId: string | null) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [idged, setIdged] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setFile(null); setIdged(''); setError(null) } }, [open])
  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      if (file) fd.append('fichier', file)
      else fd.append('idged', idged.trim())
      return callApi<{ runs: RunLigne[] }>(`/agents-ia/${slug}/essai`, { method: 'POST', body: fd })
    },
    onSuccess: (r) => onDone(r.runs[0]?.id ?? null),
    onError: (e: Error) => setError(e.message),
  })
  const ready = !!file || /^\d+$/.test(idged.trim())

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-accent" />Tester un PDF</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            L’agent lit le document avec la version active et montre ce qu’il aurait fait. Rien n’est enregistré.
          </p>
          <label className="cursor-pointer block">
            <input type="file" className="hidden" accept=".pdf,application/pdf"
              onClick={(ev) => { (ev.target as HTMLInputElement).value = '' }}
              onChange={(ev) => { const f = ev.target.files?.[0]; if (f) { setFile(f); setIdged('') } }} />
            <span className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background inline-flex items-center gap-1.5 hover:bg-accent/5">
              <Upload className="h-3.5 w-3.5" /><span className="truncate">{file ? file.name : 'Choisir un PDF'}</span>
            </span>
          </label>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">…ou le n° d’un document déjà classé (IDged)</label>
            <input value={idged} onChange={(ev) => { setIdged(ev.target.value); if (ev.target.value) setFile(null) }} inputMode="numeric" placeholder="ex. 10756"
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={!ready || mut.isPending}>
            {mut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}Lancer le test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
