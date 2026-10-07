// Agents IA › Agents — the « Classeur » layout (mps_designer §39): agents in
// the left list, master tabs in the center (Exécutions / Retours / Prompt /
// Coûts / Fonctionnement), overview in the right sidebar with the agent's
// mode as the §29.4 status footer (Arrêt / Essai / En service).
//
// API: /api/agents-ia (apps/api/src/routes/agents-ia.ts). Reads need only a
// session; piloting needs `edit_agents_ia` — checked server-side too.
//
// Nothing is scored here (decision Vincent 2026-10-02): scores are given
// where the work is done, as « Tricobot » feedback — réussite by silence,
// échec with a why (BL: at the réception of the rolls; Superviseur: the
// dashboard widget; Factures: Sous-traitants › Factures). This screen shows
// them; the « Retours » tab gathers every why of a version — what the next
// prompt is written from.
//
// One exception: the Triage (components/agents-ia/Triage.tsx), whose work IS
// the triage — it is corrected in its own run dialog (« Corriger le tri »).
//
// A BL run opens in a side-by-side dialog (what the agent read on the left,
// the PDF on the right); a Superviseur run opens on its report. The email
// sent for a BL « à vérifier » links here with ?agent=<slug>&run=<id>.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
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
  Mail,
  MessageSquare,
  MessagesSquare,
  Play,
  Power,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Settings2,
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
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { cn } from '@/lib/utils'
import {
  BaseApiProvider,
  callApi,
  fmtDateCourte,
  fmtDateHeure,
  ilYA,
  KV,
  MODE_META,
  ModeFooter,
  useBaseApi,
  useLancement,
  type Mode,
  type Lancement,
  type Sondage,
} from '@/components/agents-ia/commun'
import { TRIAGE_SLUG, TriageExecutionsTab, TriageRunDialog } from '@/components/agents-ia/Triage'

// ── Types (mirror routes/agents-ia.ts) ───────────────────

type Statut = 'ecrit' | 'simule' | 'a_verifier' | 'deja_importe' | 'ignore' | 'erreur' | 'points_a_voir' | 'rien_a_signaler' | 'mail_envoye' | 'trie'
type Source = 'gmail' | 'essai_manuel' | 'retraitement' | 'planifie' | 'manuel' | 'triage' | 'triage'
type Note = 'reussite' | 'echec'

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
  echec: number
  aEvaluer: number
}
interface ScorePoints extends BilanPoints {
  /** réussite / évalués, 0..1 — null while nothing is scored. */
  precision: number | null
}

interface GuideNotation {
  /** The one question that decides between the three scores. */
  question: string
  exemples: Record<Note, string>
  remarques: string[]
}

/** A switch a pilot sets on the agent (configuration, never a score). */
interface OptionAgent { cle: string; libelle: string; description: string; defaut: boolean; valeur: boolean }

interface AgentVue {
  options?: OptionAgent[]
  slug: string
  nom: string
  description: string
  declencheur: string
  ecritures: string[]
  abstention: string
  declenchement: { type: 'releve'; intervalleMs: number } | { type: 'quotidien'; heure: number | number[]; jours: number[] }
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
    dernierControle: DernierControle | null
  }
  sondage: Sondage
}

/** Daily agents: the last scheduled run — failed outright, or with some checks down. */
interface DernierControle {
  le: string
  erreur: string | null
  controlesEnErreur: Array<{ libelle: string; erreur: string }>
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

const PROFIL_NOM: Record<string, string> = { matel: 'MATEL', bontemps: 'Bontemps', tad: 'TAD' }

interface Controle { code: string; gravite: 'bloquant' | 'avertissement'; message: string }
interface BlPiece { numero_piece: string; poids: number | null; metrage: number | null; observations: string }
interface PieceResolue { numero_piece: string; statut: 'ok' | 'affectee_ailleurs' | 'inconnue' }

interface RunComplet extends Omit<RunLigne, 'bordereau' | 'commande' | 'nbPieces'> {
  resultat: {
    /** BL Ennoblisseur since 2026-09-28: which dyer, which document (absent before = MATEL BL). */
    profil?: 'matel' | 'bontemps' | 'tad' | null
    typeDocument?: 'bl' | 'mise_a_dispo' | null
    pages?: Array<{ nom: string; ocr: string | null; erreur: string | null }>
    extraction?: {
      numero_commande: string
      numero_bordereau: string
      numero_of?: string
      destinataire?: string
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

/** Costs are tracked in USD (Mistral's price list); shown in € at a fixed indicative rate. */
const EUR_PER_USD = 0.86

/** € cost to the centime; anything under a centime (a BL is about 0,005 $) reads « < 0,01 € ». */
const fmtEur = (usd: number) => {
  const eur = usd * EUR_PER_USD
  if (eur <= 0) return '0,00 €'
  return eur < 0.01 ? '< 0,01 €' : `${fmtNum(eur, 2)} €`
}

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
  // Triage: a mail given its categories.
  trie: { label: 'Trié', solid: 'bg-success border-success', icon: CheckCircle2 },
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
  echec: { label: 'Échec', icon: XCircle, solid: 'bg-destructive border-destructive', soft: 'bg-destructive/10 border-destructive/30', text: 'text-destructive', border: 'border-l-destructive/60', hover: 'hover:bg-destructive/10' },
}
const NOTE_ORDER: Note[] = ['reussite', 'echec']

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
  gmail: 'Mail', essai_manuel: 'Test', retraitement: 'Retraitement', planifie: 'Planifiée', manuel: 'Manuelle', triage: 'Triage',
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

/** `basePath`: the API router of this app's agents — ETM's by default, TRM
 *  passes `/agents-ia-trm` (its own menu, its own agents and permissions). */
export function AgentsIa({ basePath = '/agents-ia' }: { basePath?: string } = {}) {
  const base = basePath
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
    queryFn: () => apiFetch<AgentVue[]>(base),
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
    queryFn: () => apiFetch<AgentDetail>(`${base}/${selectedSlug}`),
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
    queryClient.invalidateQueries({ queryKey: ['agent-ia-points', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia-couts', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-ia-retours', selectedSlug] })
  }, [queryClient, selectedSlug])

  const modeMut = useMutation({
    mutationFn: (mode: Mode) => callApi(`${base}/${selectedSlug}`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    onSuccess: invalidate,
    onError: (e: Error) => setActionMessage({ tone: 'error', text: e.message }),
  })
  const optionMut = useMutation({
    mutationFn: (v: { cle: string; valeur: boolean }) => callApi(`${base}/${selectedSlug}/options`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: invalidate,
    onError: (e: Error) => setActionMessage({ tone: 'error', text: e.message }),
  })

  const lancement = useLancement<AgentDetail>({
    detailKey: ['agent-ia', selectedSlug],
    detailPath: selectedSlug ? `${base}/${selectedSlug}` : null,
    onFin: (l, suivi) => {
      invalidate()
      if (!l) {
        setActionMessage({ tone: 'error', text: 'L’exécution a été interrompue (redémarrage du serveur ?). Relancez-la.' })
        return
      }
      if (l.erreur) {
        setActionMessage({ tone: 'error', text: l.erreur })
        return
      }
      if (suivi.declenchement.type === 'quotidien') {
        const run = l.runs[0]
        const quoi = suivi.pointsEvaluables ? 'Contrôle' : 'Rapport'
        setActionMessage(run ? { tone: run.statut === 'erreur' ? 'error' : 'ok', text: `${quoi} terminé : ${run.resume}` } : { tone: 'ok', text: 'Aucune exécution lancée.' })
        if (run) setOpenRunId(run.id)
        return
      }
      setActionMessage({ tone: 'ok', text: l.runs.length ? `${l.runs.length} nouveau(x) mail(s) traité(s).` : 'Aucun nouveau mail.' })
    },
  })

  const sonderMut = useMutation({
    mutationFn: () => callApi<{ lancement: Lancement }>(`${base}/${selectedSlug}/sonder`, { method: 'POST' }),
    onSuccess: (r) => lancement.attendre(r.lancement.id),
    onError: (e: Error) => { invalidate(); setActionMessage({ tone: 'error', text: e.message }) },
  })

  // Switching agents drops the wait; the run still finishes and lands in its list.
  useEffect(() => { setActionMessage(null); lancement.abandonner() }, [selectedSlug]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <BaseApiProvider value={base}>
      <MasterDetailLayout
        list={<AgentList agents={filtered} total={agents?.length ?? 0} isLoading={isLoading} isError={isError}
          error={error as Error | null} selectedSlug={selectedSlug} onSelect={setSelectedSlug}
          searchQuery={searchQuery} onSearchChange={setSearchQuery} />}
        detailHeader={<DetailHeader agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null} canPilot={canPilot}
          onSonder={() => { setActionMessage(null); sonderMut.mutate() }} isSondant={sonderMut.isPending || lancement.enAttente || !!detail?.sondage.enCours}
          onEssai={() => setEssaiOpen(true)} message={actionMessage} onDismissMessage={() => setActionMessage(null)} />}
        detail={<DetailMain agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null}
          hasSelection={selectedSlug !== null} canPilot={canPilot} onOpenRun={setOpenRunId} onChanged={invalidate} />}
        sidebar={selectedSlug !== null ? <DetailSidebar agent={detail ?? null} canPilot={canPilot}
          onChangeMode={(m) => modeMut.mutate(m)} isChangingMode={modeMut.isPending}
          onChangeOption={(cle, valeur) => optionMut.mutate({ cle, valeur })} isChangingOption={optionMut.isPending} /> : null}
        sidebarTitle="Aperçu"
        hasSelection={selectedSlug !== null}
        onBack={() => setSelectedSlug(null)}
      />
      {selectedSlug && detail?.slug === selectedSlug && detail.slug === TRIAGE_SLUG && (
        <TriageRunDialog slug={detail.slug} runId={openRunId} canPilot={canPilot} onClose={() => setOpenRunId(null)}
          onOuvrirRunAgent={(agent, runId) => { setSelectedSlug(agent); setOpenRunId(runId) }} onChanged={invalidate} />
      )}
      {selectedSlug && detail?.slug === selectedSlug && detail.pointsEvaluables && detail.slug !== FACTURES_SST_SLUG && (
        <SuperviseurRunDialog agent={detail} runId={openRunId} onClose={() => setOpenRunId(null)} />
      )}
      {selectedSlug && detail?.slug === selectedSlug && detail.slug === FACTURES_SST_SLUG && (
        <FactureRunDialog agent={detail} runId={openRunId} canPilot={canPilot} onClose={() => setOpenRunId(null)}
          onOpenRun={setOpenRunId} onChanged={invalidate} />
      )}
      {selectedSlug && detail?.slug === selectedSlug && !detail.pointsEvaluables && detail.slug !== FACTURES_SST_SLUG && detail.slug !== TRIAGE_SLUG && (
        <RunDialog agent={detail} runId={openRunId} canPilot={canPilot} canEvaluate={canEvaluate} onClose={() => setOpenRunId(null)}
          onOpenRun={setOpenRunId} onChanged={invalidate} />
      )}
      {selectedSlug && (
        <EssaiDialog open={essaiOpen} slug={selectedSlug} onClose={() => setEssaiOpen(false)}
          onDone={(runId) => { setEssaiOpen(false); invalidate(); if (runId) setOpenRunId(runId) }} />
      )}
    </BaseApiProvider>
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
    : quotidien && !agent.pointsEvaluables ? (agent.mode === 'actif' ? 'Envoyer le rapport maintenant (depuis le dernier rapport prévu)' : 'Préparer le rapport maintenant, sans l’envoyer')
    : quotidien ? 'Lancer les contrôles maintenant — aperçu seulement : la liste des points n’est pas modifiée'
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
  const superviseur = agent.pointsEvaluables && agent.slug !== FACTURES_SST_SLUG
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2 overflow-x-auto">
        {MAIN_TABS.map((t) => {
          // The Superviseur's first tab lists its points, not its runs (2026-10-06).
          const pointsTab = t.key === 'executions' && superviseur
          const Icon = pointsTab ? ListChecks : t.icon
          const active = activeTab === t.key
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{pointsTab ? 'Points' : t.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto space-y-2 pt-3 px-1 pb-1">
        {activeTab === 'executions' && (agent.slug === TRIAGE_SLUG
          ? <TriageExecutionsTab slug={agent.slug} onOpenRun={onOpenRun} />
          : superviseur
          ? <SuperviseurPointsTab slug={agent.slug} />
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
  // « Ignorées » (a mail with no document to read) have their own tab, out of « Toutes ».
  { key: 'tout', label: 'Toutes', query: '?sans=ignore' },
  { key: 'verifier', label: 'À vérifier', query: '?statut=a_verifier,erreur' },
  { key: 'ecrit', label: 'Enregistrées', query: '?statut=ecrit' },
  { key: 'simule', label: 'Simulées', query: '?statut=simule' },
  { key: 'a_evaluer', label: 'À évaluer', query: '?note=a_evaluer' },
  { key: 'mal', label: 'Échecs', query: '?note=echec' },
  { key: 'ignore', label: 'Ignorées', query: '?statut=ignore' },
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
  const base = useBaseApi()
  const [filtre, setFiltre] = useState('tout')
  const query = RUN_FILTERS.find((f) => f.key === filtre)?.query ?? ''
  // The three document columns: a BL (bordereau, order, pieces) or an invoice (number, gaps, lots).
  const colonnes = slug === FACTURES_SST_SLUG ? ['Facture', 'Écarts', 'Lots'] : ['BL', 'Cde', 'Pc']
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-runs', slug, filtre],
    queryFn: () => apiFetch<{ total: number; runs: RunLigne[] }>(`${base}/${slug}/runs${query}`),
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
                <th className="px-3 py-2.5 text-left font-semibold">{colonnes[0]}</th>
                <th className="px-3 py-2.5 text-left font-semibold">{colonnes[1]}</th>
                <th className="px-3 py-2.5 text-right font-semibold">{colonnes[2]}</th>
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
                      {r.bilan ? <BilanMini b={r.bilan} /> : <NoteIcon evaluation={r.evaluation} />}
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
  const base = useBaseApi()
  const [version, setVersion] = useState(agent.activeVersion)
  const [filtre, setFiltre] = useState<'a_revoir' | 'tout'>('a_revoir')
  useEffect(() => { setVersion(agent.activeVersion) }, [agent.slug, agent.activeVersion])
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-retours', agent.slug, version],
    queryFn: () => apiFetch<{ version: number; retours: Retour[]; resolutions?: RetourResolution[] }>(`${base}/${agent.slug}/retours?version=${version}`),
  })
  const tous = data?.retours ?? []
  const resolutions = data?.resolutions ?? []
  // « À prendre en compte » = what says something: every échec,
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
        Chaque correction de Tricobot porte un pourquoi : c’est la liste à relire avant de publier la version suivante du prompt.
        {agent.pointsEvaluables && ' Les remarques laissées sur les points y figurent aussi.'}
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
                    {r.portee === 'point' ? `Point relevé le ${fmtDateCourte(r.runLe)}` : r.titre} · {r.par.nom}, {fmtDateHeure(r.le)}
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
            <div key={`${r.runId}-res-${i}`} onClick={() => onOpenRun(r.runId)} title="Voir le contrôle"
              className="rounded-lg border-l-4 border border-border/60 border-l-green-500/60 bg-zinc-100/80 p-3 cursor-pointer hover:border-accent/40 transition-colors">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-green-500/10">
                  <CheckCheck className="h-3.5 w-3.5 text-green-700" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" title={r.titre}>{r.titre}</p>
                  <p className="text-[11px] text-muted-foreground truncate">Point relevé le {fmtDateCourte(r.runLe)} · {r.par.nom}, {fmtDateHeure(r.le)}</p>
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
  const base = useBaseApi()
  const [draftOpen, setDraftOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = agent.versions.find((v) => v.version === agent.activeVersion) ?? agent.versions[0]
  const activerMut = useMutation({
    mutationFn: (version: number) => callApi(`${base}/${agent.slug}/versions/${version}/activer`, { method: 'POST' }),
    onSuccess: () => { setError(null); onChanged() },
    onError: (e: Error) => setError(e.message),
  })
  const livre = agent.promptLivre ?? null
  const [voirLivre, setVoirLivre] = useState(false)
  const [confirmLivre, setConfirmLivre] = useState(false)
  const prochaine = Math.max(0, ...agent.versions.map((v) => v.version)) + 1
  const publierLivreMut = useMutation({
    mutationFn: () => callApi(`${base}/${agent.slug}/versions`, { method: 'POST', body: JSON.stringify(livre) }),
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
  const api = useBaseApi()
  const [prompt, setPrompt] = useState(base.prompt)
  const [model, setModel] = useState(base.model)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) { setPrompt(base.prompt); setModel(base.model); setNote(''); setError(null) }
  }, [open, base])
  const mut = useMutation({
    mutationFn: () => callApi(`${api}/${agent.slug}/versions`, { method: 'POST', body: JSON.stringify({ prompt, model, note }) }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  })
  // What people said about the version being replaced — the reason to write a new one.
  const { data: retoursData } = useQuery({
    queryKey: ['agent-ia-retours', agent.slug, base.version],
    queryFn: () => apiFetch<{ retours: Retour[] }>(`${api}/${agent.slug}/retours?version=${base.version}`),
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
  const base = useBaseApi()
  const { data, isLoading } = useQuery({
    queryKey: ['agent-ia-couts', slug],
    queryFn: () => apiFetch<Couts>(`${base}/${slug}/couts?jours=30`),
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

/** « Réussites / échecs » of the active version, then what is left to score. */
function EvaluationsKV({ s }: { s: AgentVue['stats'] }) {
  const e = s.evaluations
  return (
    <>
      <KV label="Réussites / échecs" mono value={
        <>
          <span className={NOTE_META.reussite.text}>{fmtNum(e.reussite)}</span>{' / '}
          <span className={cn(e.echec > 0 && 'font-semibold', NOTE_META.echec.text)}>{fmtNum(e.echec)}</span>
        </>
      } />
      <KV label="À évaluer" value={fmtNum(e.aEvaluer)} mono />
    </>
  )
}

/** A point-scored agent's score: what its version raised, and how much of it
 *  was worth raising. */
/** How the last scheduled control went: the one place a failed morning shows
 *  since the Superviseur lists its points instead of its runs. */
function DernierControleKV({ d }: { d: DernierControle | null }) {
  if (!d) return <KV label="Dernier contrôle" value="—" />
  const ko = d.erreur !== null || d.controlesEnErreur.length > 0
  return (
    <>
      <KV label="Dernier contrôle" value={
        <span className={cn('inline-flex items-center gap-1', ko ? 'text-destructive font-semibold' : 'text-green-700')}>
          {ko ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {ilYA(d.le)}{d.erreur ? ' — a échoué' : ''}
        </span>
      } />
      {d.erreur && <p className="text-xs text-destructive break-words">{d.erreur}</p>}
      {d.controlesEnErreur.map((c) => (
        <p key={c.libelle} className="text-xs text-destructive break-words" title={c.erreur}>
          <span className="font-semibold">{c.libelle} n’a pas tourné : </span>{c.erreur}
        </p>
      ))}
    </>
  )
}

function PointsKV({ p }: { p: ScorePoints }) {
  const pct = p.precision === null ? null : Math.round(p.precision * 100)
  const tone = pct === null ? 'text-muted-foreground' : pct >= 80 ? NOTE_META.reussite.text : pct >= 50 ? 'text-amber-800' : NOTE_META.echec.text
  return (
    <>
      <KV label="Points signalés" value={fmtNum(p.points)} mono />
      <KV label="Réussites / échecs" mono value={
        <>
          <span className={NOTE_META.reussite.text}>{fmtNum(p.reussite)}</span>{' / '}
          <span className={cn(p.echec > 0 && 'font-semibold', NOTE_META.echec.text)}>{fmtNum(p.echec)}</span>
        </>
      } />
      <KV label="À évaluer" value={fmtNum(p.aEvaluer)} mono />
      <KV label="Précision" value={<span className={cn('font-semibold', tone)}>{pct === null ? '—' : `${fmtNum(pct)} %`}</span>} mono />
    </>
  )
}

function DetailSidebar({ agent, canPilot, onChangeMode, isChangingMode, onChangeOption, isChangingOption }: {
  agent: AgentDetail | null; canPilot: boolean; onChangeMode: (m: Mode) => void; isChangingMode: boolean
  onChangeOption: (cle: string, valeur: boolean) => void; isChangingOption: boolean
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
                <DernierControleKV d={s.dernierControle} />
                {agent.sondage.derniereErreur && (
                  <div className="flex items-start gap-1.5 mt-1 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>{agent.sondage.derniereErreur}</span>
                  </div>
                )}
                <KV label={`Coût v${agent.activeVersion}`} value={fmtEur(s.coutUsd)} mono />
              </div>
              {s.points && (
                <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><ListChecks className="h-3.5 w-3.5" />Version {agent.activeVersion} — points</p>
                  <PointsKV p={s.points} />
                  <p className="text-[11px] text-muted-foreground pt-1">Précision = réussites sur points évalués (réussites + échecs). Un point fermé sans que personne ne le corrige compte comme réussite ; une version n’est notée que sur les points qu’elle a signalés en premier. Les commentaires sont regroupés dans l’onglet Retours. Une nouvelle version repart de zéro.</p>
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
            {s.points ? <PointsKV p={s.points} /> : <EvaluationsKV s={s} />}
            <KV label="Coût" value={fmtEur(s.coutUsd)} mono />
            <p className="text-[11px] text-muted-foreground pt-1">
              {s.points
                ? 'Chaque ligne est notée par la personne qui traite la facture, dans Sous-traitants › Factures. Précision = lignes justes sur lignes évaluées.'
                : 'Chaque lecture est notée à la réception des rouleaux : reçus tels que Tricobot les a lus = réussite, une valeur corrigée = échec. Les tests manuels ne comptent pas.'} Les commentaires sont regroupés dans l’onglet Retours. Une nouvelle version repart de zéro.
            </p>
          </div>
          </>)}
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Mode</p>
            <p className="text-sm">{agent.modes[agent.mode]}</p>
            {agent.modeChangedBy && (
              <p className="text-[11px] text-muted-foreground">Changé par {agent.modeChangedBy.nom} le {fmtDateHeure(agent.modeChangedAt)}</p>
            )}
          </div>
          {(agent.options ?? []).length > 0 && (
            <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2.5">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Settings2 className="h-3.5 w-3.5" />Réglages</p>
              {(agent.options ?? []).map((o) => (
                <div key={o.cle} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{o.libelle}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{o.description}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={o.valeur}
                    aria-label={o.libelle}
                    disabled={!canPilot || isChangingOption}
                    title={canPilot ? undefined : 'Droit « Piloter les agents IA » requis'}
                    onClick={() => onChangeOption(o.cle, !o.valeur)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors mt-0.5',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      o.valeur ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                    )}
                  >
                    <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out', o.valeur ? 'translate-x-[18px]' : 'translate-x-0.5')} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ModeFooter current={agent.mode} descriptions={agent.modes} onChange={onChangeMode} isChanging={isChangingMode} disabled={!canPilot} />
    </div>
  )
}

// ── Scores (read-only) ───────────────────────────────────
// One scale for every agent: réussite / échec (binary since 2026-10-02),
// given where the work is done — never here.

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
 *  in one click; échec opens a comment first. Read-only in Agents IA. */
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
            Évalué {NOTE_META[herite.note].label.toLowerCase()} un jour précédent par {herite.par.nom}{herite.commentaire ? ` : « ${herite.commentaire} »` : ''}
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
  const base = useBaseApi()
  const slug = agent.slug
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const [showOcr, setShowOcr] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPage(0); setShowOcr(false); setError(null) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunComplet>(`${base}/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })

  const retraiterMut = useMutation({
    mutationFn: () => callApi<{ runs: RunLigne[] }>(`${base}/${slug}/runs/${runId}/retraiter`, { method: 'POST' }),
    onSuccess: (r) => { onChanged(); if (r.runs[0]) onOpenRun(r.runs[0].id) },
    onError: (e: Error) => setError(e.message),
  })
  const ecriture = run?.resultat.ecriture ?? null
  const e = run?.resultat.extraction ?? null
  const res = run?.resultat.resolution ?? null
  const controles = run?.resultat.controles ?? []
  const statutPiece = (numero: string, i: number) => res?.pieces[i]?.numero_piece === numero ? res.pieces[i].statut : res?.pieces.find((p) => p.numero_piece === numero)?.statut
  const pdfUrl = run && run.fichiers.length > 0 ? `${API_URL}${base}/${slug}/runs/${run.id}/fichiers/${page}#view=FitH` : null
  const somme = (k: 'poids' | 'metrage') => e ? e.pieces.reduce((s, p) => s + (p[k] ?? 0), 0) : 0
  // Runs before 2026-09-28 carry no profil: they were all MATEL BLs.
  const profil = run?.resultat.profil ?? (e ? 'matel' : null)
  const miseADispo = run?.resultat.typeDocument === 'mise_a_dispo'
  const titre = !e ? 'Exécution'
    : miseADispo ? `${PROFIL_NOM[profil ?? ''] ?? ''} · Mise à dispo${e.numero_of ? ` OF ${e.numero_of}` : ''}`
    : `${profil && profil !== 'matel' ? `${PROFIL_NOM[profil]} · ` : ''}BL ${e.numero_bordereau || 'illisible'}`

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-6xl w-[94vw] h-[88vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <FileText className="h-5 w-5 text-accent" />
            {titre}
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
                  <KV label="Ennoblisseur" value={`${PROFIL_NOM[profil ?? ''] ?? '—'}${miseADispo ? ' — stock fini à disposition' : ''}`} />
                  <KV label="Commande" value={e.numero_commande || '—'} mono />
                  <KV label="Ligne de commande" value={res?.ligneId ? `#${res.ligneId}${e.ligne ? ` (imprimé : ligne ${e.ligne})` : ''}` : '—'} mono />
                  <KV label="Lot" value={res?.lot || '—'} mono />
                  {profil && profil !== 'matel' && <KV label="Poids" value="non repris (Malterre pèse les rouleaux)" />}
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
              <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><TricobotMascot className="h-4 w-4" />Retour Tricobot</p>
                {run.evaluation
                  ? <EvaluationLue evaluation={run.evaluation} />
                  : <p className="text-xs text-muted-foreground italic">Pas encore de retour : il est donné à la réception des rouleaux (Sous-traitants › Commandes).</p>}
              </div>
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

// ── Factures Ennoblisseur (one run = one invoice) ────────
// The run shows what the agent read and decided on one dyer invoice; the
// invoice itself is handled on Sous-traitants › Factures, where a run in
// « actif » stored it.

const FACTURES_SST_SLUG = 'factures-ennoblisseur'

type VerdictFacture = 'conforme' | 'ecart' | 'info'
interface ControleFacture { code: string; gravite: 'bloquant' | 'avertissement' | 'info'; message: string }
interface ResultatFacture {
  fournisseur: string | null
  pages?: Array<{ nom: string; ocr: string | null; erreur: string | null }>
  extraction: { numero_facture: string; date_facture: string; total_ht: number | null; total_ttc: number | null; type_document: string } | null
  verification: {
    statut: 'conforme' | 'ecarts'
    ecartMontant: number
    controles: ControleFacture[]
    lignes: Array<{
      lotEtm: string
      verdict: VerdictFacture
      nature: 'reel' | 'non_verifie' | null
      ecartMontant: number
      controles: ControleFacture[]
      ligne: { description: string; quantite: number | null; unite: string; prix_unitaire: number | null; montant: number | null; genre: string }
      etm: { prixAttendu: number | null; poids: number | null; idcommande: number } | null
    }>
  } | null
  statutFacture: 'conforme' | 'ecarts' | null
  ecriture: { idFacture: number; numFactureEcrits: number[]; retire?: { le: string } } | null
}

const VERDICT_FACTURE: Record<VerdictFacture, { label: string; cls: string }> = {
  ecart: { label: 'Écart', cls: 'text-destructive font-semibold' },
  conforme: { label: 'Conforme', cls: 'text-green-700' },
  info: { label: '—', cls: 'text-muted-foreground' },
}
const STATUT_FACTURE_LABEL: Record<string, string> = { conforme: 'Conforme', ecarts: 'Écarts' }
const FOURNISSEUR_NOM: Record<string, string> = { matel: 'MATEL', bontemps: 'Bontemps', tad: 'TAD' }

/** Read-only: the lines are scored on Sous-traitants › Factures by the person
 *  who checks the invoice (decision Vincent 2026-10-02), shown here as given. */
function FactureRunDialog({ agent, runId, canPilot, onClose, onOpenRun, onChanged }: {
  agent: AgentDetail; runId: string | null; canPilot: boolean; onClose: () => void
  onOpenRun: (id: string) => void; onChanged: () => void
}) {
  const base = useBaseApi()
  const slug = agent.slug
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [toutes, setToutes] = useState(false)
  const [showOcr, setShowOcr] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setToutes(false); setShowOcr(false); setError(null) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<Omit<RunComplet, 'resultat'> & { resultat: ResultatFacture; avisPoints?: Record<string, Evaluation> }>(`${base}/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })
  const retraiterMut = useMutation({
    mutationFn: () => callApi<{ runs: RunLigne[] }>(`${base}/${slug}/runs/${runId}/retraiter`, { method: 'POST' }),
    onSuccess: (r) => { onChanged(); if (r.runs[0]) onOpenRun(r.runs[0].id) },
    onError: (e: Error) => setError(e.message),
  })

  const res = run?.resultat
  const f = res?.extraction ?? null
  const v = res?.verification ?? null
  const ecriture = res?.ecriture ?? null
  const pdfUrl = run && run.fichiers.length > 0 ? `${API_URL}${base}/${slug}/runs/${run.id}/fichiers/0#view=FitH` : null
  // Keyed like the server (lib/agents/factures-sst/points.ts clePoint): invoice | position | lot.
  const numero = f?.numero_facture || '?'
  const cleDe = (i: number, lot: string) => `${numero}|${i}|${lot}`
  const avisPoints = run?.avisPoints ?? {}
  const souleve = (vd: VerdictFacture) => vd === 'ecart'
  const lignes = v ? v.lignes.map((l, i) => ({ l, i })).filter(({ l, i }) => l.ligne.genre === 'lot' && (toutes || souleve(l.verdict) || avisPoints[cleDe(i, l.lotEtm)])) : []
  const aEvaluer = v ? v.lignes.filter((l) => l.ligne.genre === 'lot' && souleve(l.verdict)) : []
  const lecture = (v?.controles ?? []).filter((c) => c.gravite === 'bloquant')
  const nbEvalues = Object.keys(avisPoints).length
  const lots = v ? new Set(v.lignes.filter((l) => l.lotEtm).map((l) => l.lotEtm)).size : 0
  const titre = f ? `${FOURNISSEUR_NOM[res?.fournisseur ?? ''] ?? ''} · Facture ${f.numero_facture || 'illisible'}` : 'Exécution'

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-6xl w-[94vw] h-[88vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <ReceiptText className="h-5 w-5 text-accent" />
            {titre}
            {run && <StatutPill statut={run.statut} className="text-xs py-0.5" />}
            {run && <span className="text-xs font-normal text-muted-foreground">{fmtDateHeure(run.createdAt)} · {SOURCE_LABEL[run.source]} · v{run.version}</span>}
          </DialogTitle>
        </DialogHeader>
        {isLoading || !run ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
        ) : (
          <div className="mt-4 flex-1 min-h-0 flex flex-col md:flex-row gap-4">
            <div className="md:w-[50%] flex-shrink-0 min-h-0 overflow-y-auto space-y-3 px-1 scrollbar-transparent">
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
              {lecture.length > 0 && (
                <div className="rounded-lg border border-l-4 border-border/60 border-l-destructive/60 bg-destructive/5 p-2.5 text-sm">
                  <p className="text-xs font-semibold text-destructive mb-1">Lecture à vérifier</p>
                  {lecture.map((c, i) => <p key={i} className="text-destructive">{c.message}</p>)}
                </div>
              )}
              {(v?.controles ?? []).filter((c) => c.gravite === 'avertissement').map((c, i) => (
                <div key={i} className={cn('rounded-lg border border-l-4 border-border/60 p-2.5 text-sm flex gap-2',
                  c.gravite === 'bloquant' ? 'border-l-destructive/60 bg-destructive/5 text-destructive' : 'border-l-amber-400/60 bg-amber-400/10 text-amber-800')}>
                  {c.gravite === 'bloquant' ? <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                  <span>{c.message}</span>
                </div>
              ))}
              {ecriture && (
                ecriture.retire ? (
                  <div className="rounded-lg border-l-4 border-l-border border border-border/60 bg-zinc-100/80 p-3 text-sm text-muted-foreground flex gap-2">
                    <EyeOff className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span>Facture enregistrée, puis retirée le {fmtDateHeure(ecriture.retire.le)} (évaluation en échec).</span>
                  </div>
                ) : (
                  <div className="rounded-lg border-l-4 border-l-green-500/60 border border-border/60 bg-green-500/5 p-3 text-sm text-green-700 flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <span className="flex-1">Facture enregistrée{ecriture.numFactureEcrits.length ? `, n° reporté sur ${ecriture.numFactureEcrits.length} ligne(s) de commande` : ''}.</span>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-accent hover:text-accent hover:bg-accent/10 flex-shrink-0"
                      onClick={() => navigate(`/sous-traitants/factures?facture=${ecriture.idFacture}`)}>
                      Ouvrir<ExternalLink className="h-3 w-3 ml-1" />
                    </Button>
                  </div>
                )
              )}
              {f && (
                <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1">
                  <KV label="Ennoblisseur" value={FOURNISSEUR_NOM[res?.fournisseur ?? ''] ?? '—'} />
                  <KV label="Facture" value={`${f.numero_facture || '—'}${f.date_facture ? ` du ${f.date_facture.split('-').reverse().join('/')}` : ''}`} mono />
                  <KV label="Total HT" value={f.total_ht != null ? `${fmtNum(f.total_ht, 2)} €` : '—'} mono />
                  {v && <KV label="Verdict" value={`${STATUT_FACTURE_LABEL[v.statut] ?? v.statut} · ${lots} lot(s)${v.ecartMontant > 0 ? ` · ${fmtNum(v.ecartMontant, 2)} € en trop` : ''}`} />}
                </div>
              )}
              {v && v.lignes.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/60 bg-zinc-200/60">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                      {toutes ? 'Toutes les lignes' : 'Lignes à évaluer'}
                      <span className="ml-2 normal-case tracking-normal font-normal tabular-nums">{nbEvalues} évaluée{nbEvalues > 1 ? 's' : ''} · {aEvaluer.length} signalée{aEvaluer.length > 1 ? 's' : ''}</span>
                    </span>
                    <button type="button" onClick={() => setToutes((x) => !x)} className="text-xs text-muted-foreground hover:text-foreground">
                      {toutes ? 'Seulement à voir' : `Toutes (${v.lignes.length})`}
                    </button>
                  </div>
                  {lignes.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-muted-foreground italic">Aucune ligne signalée.</p>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {lignes.map(({ l, i }) => (
                        <div key={i} className="px-2 py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium tabular-nums w-24 truncate" title={l.lotEtm || l.ligne.description}>{l.lotEtm || l.ligne.description}</span>
                            <span className="tabular-nums text-muted-foreground">{l.ligne.quantite != null ? `${fmtNum(l.ligne.quantite, 2)} ${l.ligne.unite}` : ''}</span>
                            <span className="tabular-nums">{l.ligne.prix_unitaire != null ? `${fmtNum(l.ligne.prix_unitaire, 2)} €` : ''}{l.etm?.prixAttendu != null ? <span className="text-muted-foreground"> / {fmtNum(l.etm.prixAttendu, 2)}</span> : null}</span>
                            <span className={cn('ml-auto', VERDICT_FACTURE[l.verdict].cls)}>{VERDICT_FACTURE[l.verdict].label}{l.verdict === 'ecart' && l.nature === 'non_verifie' ? ' (non vérifié)' : ''}</span>
                          </div>
                          {l.controles.filter((c) => c.gravite !== 'info').map((c, j) => <p key={j} className="text-[11px] text-muted-foreground mt-0.5">{c.message}</p>)}
                          <PointEvaluation avis={avisPoints[cleDe(i, l.lotEtm)]} herite={undefined} textes={agent.evaluation} canEvaluate={false}
                            onSave={async () => undefined} isPending={false} className="mt-1.5" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {(res?.pages ?? []).some((p) => p.ocr) && (
                <div>
                  <button type="button" onClick={() => setShowOcr((x) => !x)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {showOcr ? 'Masquer le texte lu (OCR)' : 'Afficher le texte lu (OCR)'}
                  </button>
                  {showOcr && (
                    <pre className="mt-2 text-[11px] whitespace-pre-wrap font-mono bg-zinc-100/80 rounded-md p-3 max-h-80 overflow-auto scrollbar-transparent">
                      {(res?.pages ?? []).map((p) => p.ocr ?? '').join('\n\n')}
                    </pre>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0 min-h-[300px] flex flex-col gap-2">
              <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
                {pdfUrl ? <iframe key={pdfUrl} src={pdfUrl} className="w-full h-full" title="Facture" />
                : <div className="h-full flex flex-col items-center justify-center text-muted-foreground"><FileText className="h-12 w-12 opacity-30" /><p className="text-sm">Aucun PDF</p></div>}
              </div>
              <p className="text-[11px] text-muted-foreground px-1">Les lignes se notent dans Sous-traitants › Factures, en traitant la facture.</p>
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
/** One line in a list row: how many of the run's points are scored. */
function BilanMini({ b }: { b: BilanPoints }) {
  if (b.points === 0) return null
  const fini = b.aEvaluer === 0
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] tabular-nums whitespace-nowrap', fini ? 'text-green-700' : 'text-muted-foreground')}
      title={`${b.evalues} point(s) évalué(s) sur ${b.points}`}>
      {fini ? <CheckCheck className="h-3 w-3" /> : <Clock className="h-3 w-3" />}{b.evalues}/{b.points}
    </span>
  )
}

function joursDepuis(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

// ── Superviseur: the points it raised ────────────────────
// Decision 2026-10-06: the Superviseur's tab lists the POINTS, not the morning
// reports — a report only re-copied the points still open, so the same point
// showed in five rows and the counts mixed new and carried-over ones. One row
// per point (GET /:slug/points/historique, superviseur/historique.ts), dated by
// the day it appeared; how it ended comes from the dashboard widget, where
// Isabelle handles it — nothing is decided here.

interface PointTraitement { issue: 'traite' | 'fausse_alerte'; note: Note; commentaire: string; par: Auteur; le: string }
interface PointHistorique {
  id: string
  cle: string
  domaine: string
  gravite: Gravite
  titre: string
  message: string
  lien: string | null
  depuis: string
  vuLe: string
  fermeLe: string | null
  raisonFermeture: string | null
  traitement: PointTraitement | null
}

type EtatPoint = 'ouvert' | 'clos' | 'traite' | 'corrige' | 'fausse_alerte'
const etatPoint = (p: PointHistorique): EtatPoint =>
  p.traitement?.issue === 'fausse_alerte' ? 'fausse_alerte'
  : p.traitement ? (p.traitement.note === 'echec' ? 'corrige' : 'traite')
  : p.fermeLe ? 'clos' : 'ouvert'

const ETAT_POINT_META: Record<EtatPoint, { label: string; cls: string; icon: ComponentType<{ className?: string }>; title: string }> = {
  ouvert: { label: 'À traiter', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-800', icon: Clock,
    title: 'Toujours relevé, personne ne l’a encore traité' },
  clos: { label: 'Disparu', cls: 'border-zinc-300 bg-zinc-100 text-zinc-700', icon: CheckCircle2,
    title: 'Le contrôle ne le relève plus, sans que personne l’ait traité' },
  traite: { label: 'Traité', cls: 'border-green-500/30 bg-green-500/10 text-green-700', icon: CheckCheck,
    title: 'Traité dans le tableau de bord : l’alerte était juste' },
  corrige: { label: 'Traité · Tricobot corrigé', cls: 'border-destructive/30 bg-destructive/5 text-destructive', icon: TricobotMascot,
    title: 'Traité, avec une remarque sur ce que Tricobot aurait dû dire' },
  fausse_alerte: { label: 'Fausse alerte', cls: 'border-destructive/30 bg-destructive/10 text-destructive', icon: XCircle,
    title: 'Rien à faire : l’alerte était fausse' },
}

const POINT_FILTRES: Array<{ key: string; label: string; garde: (e: EtatPoint) => boolean }> = [
  { key: 'tous', label: 'Tous', garde: () => true },
  { key: 'ouverts', label: 'À traiter', garde: (e) => e === 'ouvert' },
  { key: 'traites', label: 'Traités', garde: (e) => e === 'traite' || e === 'corrige' },
  { key: 'fausses', label: 'Fausses alertes', garde: (e) => e === 'fausse_alerte' },
  { key: 'clos', label: 'Disparus', garde: (e) => e === 'clos' },
]

const fmtJour = (iso: string) => new Date(iso).toLocaleDateString('fr-FR')

function SuperviseurPointsTab({ slug }: { slug: string }) {
  const base = useBaseApi()
  const [filtre, setFiltre] = useState('tous')
  const [deplieId, setDeplieId] = useState<string | null>(null)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-points', slug],
    queryFn: () => apiFetch<{ points: PointHistorique[] }>(`${base}/${slug}/points/historique`),
    refetchInterval: 30_000,
  })
  // Newest first by the day it appeared — not by the last thing that happened to it.
  const tous = useMemo(() => [...(data?.points ?? [])].sort((a, b) => b.depuis.localeCompare(a.depuis)), [data])
  const parFiltre = useMemo(() => {
    const m = new Map<string, PointHistorique[]>()
    for (const f of POINT_FILTRES) m.set(f.key, tous.filter((p) => f.garde(etatPoint(p))))
    return m
  }, [tous])
  const points = parFiltre.get(filtre) ?? tous

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {POINT_FILTRES.map((f) => (
          <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
            className={cn('px-3 py-1 text-xs rounded-md transition-colors tabular-nums',
              filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
            {f.label}{data && f.key !== 'tous' ? ` (${parFiltre.get(f.key)?.length ?? 0})` : ''}
          </button>
        ))}
        {data && <span className="ml-auto text-xs text-muted-foreground">{tous.length} point{tous.length !== 1 ? 's' : ''} relevé{tous.length !== 1 ? 's' : ''}</span>}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Chargement impossible</p></div>
      : points.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Inbox className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">Aucun point</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '58%' }} /><col style={{ width: '14%' }} /><col style={{ width: '24%' }} /><col style={{ width: '4%' }} />
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Point</th>
                <th className="px-3 py-2.5 text-left font-semibold">Apparu le</th>
                <th className="px-3 py-2.5 text-left font-semibold">État</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <PointLigne key={p.id} p={p} deplie={deplieId === p.id} onToggle={() => setDeplieId((v) => (v === p.id ? null : p.id))} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function PointLigne({ p, deplie, onToggle }: { p: PointHistorique; deplie: boolean; onToggle: () => void }) {
  const g = GRAVITE_META[p.gravite]
  const GIcon = g.icon
  const etat = etatPoint(p)
  const m = ETAT_POINT_META[etat]
  const EIcon = m.icon
  const { contexte, action } = decouperMessage(p.message)
  const j = joursDepuis(p.depuis)
  const t = p.traitement
  return (
    <>
      <tr onClick={onToggle}
        className={cn('border-b border-border/40 cursor-pointer transition-colors select-none',
          deplie ? 'bg-accent/10' : 'hover:bg-accent/5')}>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', g.iconBg)}>
              <GIcon className={cn('h-3.5 w-3.5', g.iconCls)} />
            </div>
            <div className="min-w-0">
              <p className={cn('truncate', etat === 'ouvert' ? 'font-medium' : 'text-muted-foreground')} title={p.titre}>{p.titre}</p>
              <p className="text-[11px] text-muted-foreground truncate">{DOMAINE_LIBELLE[p.domaine] ?? p.domaine}</p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2 tabular-nums whitespace-nowrap">
          <div>{fmtJour(p.depuis)}</div>
          {etat === 'ouvert' && <div className="text-[11px] text-muted-foreground">{j === 0 ? 'aujourd’hui' : `depuis ${j} j`}</div>}
        </td>
        <td className="px-3 py-2">
          <span title={m.title} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium max-w-full', m.cls)}>
            <EIcon className="h-3 w-3 flex-shrink-0" /><span className="truncate">{m.label}</span>
          </span>
        </td>
        <td className="pr-3 py-2 text-right">
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform inline', deplie && 'rotate-180')} />
        </td>
      </tr>
      {deplie && (
        <tr className="border-b border-border/40 bg-zinc-50">
          <td colSpan={4} className="px-3 py-3">
            <div className="ml-9 space-y-2">
              {contexte && <p className="text-[13px] leading-relaxed text-muted-foreground whitespace-pre-line">{contexte}</p>}
              {action && (
                <div className="flex items-start gap-2 rounded-md border border-accent/25 bg-accent/[0.07] px-2.5 py-1.5">
                  <ArrowRight className="h-3.5 w-3.5 text-amber-700 flex-shrink-0 mt-[3px]" />
                  <p className="text-[13px] leading-snug"><span className="font-semibold text-amber-800">À faire : </span>{action}</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Apparu le {fmtDateHeure(p.depuis)}</span>
                <span>{p.fermeLe ? `Plus relevé le ${fmtDateHeure(p.fermeLe)}` : `Encore relevé le ${fmtDateHeure(p.vuLe)}`}</span>
                {p.lien && (
                  <Link to={p.lien} className="inline-flex items-center gap-1 text-accent-blue hover:underline">
                    <ExternalLink className="h-3 w-3" />Ouvrir dans ETM
                  </Link>
                )}
              </div>
              {p.raisonFermeture && (
                <p className="text-xs"><span className="font-semibold">Pourquoi il a disparu : </span>{p.raisonFermeture}</p>
              )}
              {t && (
                <p className="text-xs">
                  <span className={cn('font-semibold', etat === 'traite' ? 'text-green-700' : 'text-destructive')}>{m.label}</span>
                  {t.commentaire && <span> : {t.commentaire}</span>}
                  <span className="text-muted-foreground"> — {t.par.nom}, {fmtDateHeure(t.le)}</span>
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** One point of a report, as it stands: its score and résolu come from the
 *  dashboard widget, where Isabelle handles it — nothing is decided here. */
function ConstatCard({ c, avis, resolution, textes, estompe }: {
  c: ConstatRun
  avis: Evaluation | undefined
  /** Marked résolu on THIS report (a carried one is `c.resolution`). */
  resolution: Resolution | undefined
  textes: Record<Note, string>
  /** Set aside (false alarm): shown quieter. */
  estompe?: boolean
}) {
  // A resolved point folds to its title + how it was settled; the detail
  // stays one click away.
  const [deplie, setDeplie] = useState(false)
  const res = resolution ?? c.resolution
  const replie = !!res && !deplie
  const g = GRAVITE_META[c.gravite]
  const Icon = res ? CheckCircle2 : g.icon
  const j = joursDepuis(c.depuis)
  const { contexte, action } = decouperMessage(c.message)
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

      {/* What people did about it (from the widget): how it was settled, its score. */}
      {(res || avis || c.avis) && (
        <div className="border-t border-border/50 bg-zinc-50 px-3 py-2 space-y-1.5">
          {res && (
            <div className="flex items-start gap-1.5 text-xs">
              <CheckCheck className="h-3.5 w-3.5 text-green-700 flex-shrink-0 mt-px" />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-green-700">Résolu{resolution ? '' : ' un jour précédent'} : </span>
                <span>{res.commentaire}</span>
                <span className="text-muted-foreground"> — {res.par.nom}, {fmtDateHeure(res.le)}</span>
              </span>
            </div>
          )}
          <PointEvaluation avis={avis} herite={c.avis} textes={textes} canEvaluate={false} onSave={async () => undefined} isPending={false} className="min-w-0" />
        </div>
      )}
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
/** Read-only: Agents IA watches the agent, it never scores it — Isabelle
 *  handles (and so scores) the points from the dashboard Notifications widget
 *  (decision Vincent 2026-10-02). */
function SuperviseurRunDialog({ agent, runId, onClose }: {
  agent: AgentDetail; runId: string | null; onClose: () => void
}) {
  const base = useBaseApi()
  const slug = agent.slug
  const [showControles, setShowControles] = useState(false)
  const [showEcartes, setShowEcartes] = useState(false)
  const [showResolusAvant, setShowResolusAvant] = useState(false)
  useEffect(() => { setShowControles(false); setShowEcartes(false) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunSuperviseur>(`${base}/${slug}/runs/${runId}`),
    enabled: runId !== null,
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
  // What changed on THIS report: points handled earlier that the check still
  // finds come back every morning, so they are folded away and not counted.
  const nbResolus = fermes.length + resolusIci
  const pct = constats.length ? Math.round(((constats.length - aEvaluer) / constats.length) * 100) : 0

  const carte = (c: ConstatRun, estompe = false) => (
    <ConstatCard key={c.cle} c={c} avis={avis[c.cle]} resolution={resolutions[c.cle]} textes={agent.evaluation} estompe={estompe} />
  )

  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl w-[94vw] h-[88vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <ShieldCheck className="h-5 w-5 text-accent" />
            {run ? (run.source === 'planifie' ? `Contrôle du ${fmtDateHeure(run.createdAt)}` : `Aperçu du contrôle — ${fmtDateHeure(run.createdAt)}`) : 'Contrôle'}
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
            <p className="text-xs text-muted-foreground">Aperçu : rien n’est enregistré, la liste des points de l’onglet Points n’a pas changé.</p>
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
              { key: 'echec', label: 'Fausses alertes', value: fmtNum(compte('echec')), tone: compte('echec') > 0 ? NOTE_META.echec.text : undefined,
                sub: ecartes.length > 0 ? `${fmtNum(ecartes.length)} écartée${ecartes.length > 1 ? 's' : ''} avant` : undefined },
              { key: 'fermes', label: 'Résolus', value: fmtNum(nbResolus), tone: nbResolus > 0 ? NOTE_META.reussite.text : undefined,
                sub: `${fmtNum(fermes.length)} constatés · ${fmtNum(resolusIci)} à la main` },
            ]} />

            <div className="flex-shrink-0 flex items-center justify-between gap-3 text-xs text-muted-foreground px-1">
              <div className="min-w-0 flex items-center gap-3">
                <span className="min-w-0 truncate">
                  {constats.length === 0 ? ''
                    : aEvaluer > 0 ? 'Les points se traitent — et se notent — dans le widget Notifications du tableau de bord.'
                    : 'Tous les points sont évalués.'}
                </span>
              </div>
              <button type="button" onClick={() => setShowControles((v) => !v)} className="flex-shrink-0 hover:text-foreground transition-colors">
                {showControles ? 'Masquer les contrôles exécutés' : `Afficher les contrôles exécutés (${controles.length})`}
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 px-1 pb-1 scrollbar-transparent">
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

              {resolusAvant.length > 0 && (
                <div className="pt-1">
                  <button type="button" onClick={() => setShowResolusAvant((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                    <CheckCheck className="h-3.5 w-3.5" />
                    {showResolusAvant
                      ? 'Masquer les points traités auparavant'
                      : `Traités auparavant, toujours détectés (${resolusAvant.length}) — le contrôle ne voit pas comment ils ont été réglés`}
                  </button>
                  {showResolusAvant && <div className="mt-2 space-y-2">{resolusAvant.map((c) => carte(c))}</div>}
                </div>
              )}

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
  const base = useBaseApi()
  const [file, setFile] = useState<File | null>(null)
  const [idged, setIdged] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setFile(null); setIdged(''); setError(null) } }, [open])
  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      if (file) fd.append('fichier', file)
      else fd.append('idged', idged.trim())
      return callApi<{ runs: RunLigne[] }>(`${base}/${slug}/essai`, { method: 'POST', body: fd })
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
