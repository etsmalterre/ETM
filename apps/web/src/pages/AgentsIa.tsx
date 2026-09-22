// Agents IA › Agents — the « Classeur » layout (mps_designer §39): agents in
// the left list, master tabs in the center (Exécutions / Prompt / Coûts /
// Fonctionnement), overview in the right sidebar with the agent's mode as the
// §29.4 status footer (Arrêt / Essai / En service).
//
// API: /api/agents-ia (apps/api/src/routes/agents-ia.ts). Reads need only a
// session; every action needs `edit_agents_ia`, checked server-side too.
//
// A run opens in a side-by-side dialog: what the agent read and decided on
// the left, the PDF on the right. The email sent for a BL « à vérifier » links
// here with ?agent=<slug>&run=<id>.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronUp,
  CircleDollarSign,
  CircleSlash,
  Clock,
  Copy,
  FileText,
  FlaskConical,
  History,
  Inbox,
  Info,
  Loader2,
  Mail,
  MessageSquare,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  ThumbsDown,
  ThumbsUp,
  Upload,
  Workflow,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// ── Types (mirror routes/agents-ia.ts) ───────────────────

type Mode = 'off' | 'essai' | 'actif'
type Statut = 'ecrit' | 'simule' | 'a_verifier' | 'deja_importe' | 'ignore' | 'erreur'
type Source = 'gmail' | 'essai_manuel' | 'retraitement'

interface Auteur { id: number; nom: string }

interface AgentVue {
  slug: string
  nom: string
  description: string
  declencheur: string
  ecritures: string[]
  mode: Mode
  startedAt: string | null
  modeChangedAt: string | null
  modeChangedBy: Auteur | null
  versionActive: { version: number; model: string }
  stats: {
    total: number
    parStatut: Partial<Record<Statut, number>>
    verdicts: { correct: number; incorrect: number }
    coutUsd: number
    dernierRun: string | null
  }
  sondage: { dernierSondage: string | null; dernierSucces: string | null; derniereErreur: string | null; enCours: boolean }
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
  verdict?: { valeur: 'correct' | 'incorrect'; commentaire: string; par: Auteur; le: string } | null
  fichiers: Array<{ nom: string; taille: number }>
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
    ecriture?: { gedId: number | null; lignesEcrites: number } | null
  }
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

/** USD cost as millièmes of a dollar when tiny — a BL costs about 0,005 $. */
const fmtUsd = (v: number, decimals = 2) => (v < 0.1 ? `${fmtNum(v * 1000, decimals)} m$` : `${fmtNum(v, 2)} $`)

const MODE_META: Record<Mode, { label: string; icon: ComponentType<{ className?: string }>; solid: string; description: string }> = {
  off: { label: 'À l’arrêt', icon: CircleSlash, solid: 'bg-zinc-500 border-zinc-500', description: 'Ne lit pas la boîte mail.' },
  essai: { label: 'En essai', icon: FlaskConical, solid: 'bg-sky-600 border-sky-600', description: 'Lit et analyse, n’enregistre rien.' },
  actif: { label: 'En service', icon: Power, solid: 'bg-success border-success', description: 'Lit, analyse et enregistre.' },
}
const MODE_ORDER: Mode[] = ['off', 'essai', 'actif']

const STATUT_META: Record<Statut, { label: string; solid: string; icon: ComponentType<{ className?: string }> }> = {
  ecrit: { label: 'Enregistré', solid: 'bg-success border-success', icon: CheckCircle2 },
  simule: { label: 'Simulé', solid: 'bg-sky-600 border-sky-600', icon: FlaskConical },
  a_verifier: { label: 'À vérifier', solid: 'bg-destructive border-destructive', icon: AlertTriangle },
  deja_importe: { label: 'Déjà importé', solid: 'bg-zinc-500 border-zinc-500', icon: Copy },
  ignore: { label: 'Ignoré', solid: 'bg-zinc-400 border-zinc-400', icon: CircleSlash },
  erreur: { label: 'Erreur', solid: 'bg-red-800 border-red-800', icon: XCircle },
}

const SOURCE_LABEL: Record<Source, string> = { gmail: 'Mail', essai_manuel: 'Test', retraitement: 'Retraitement' }

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

  useAutoSelectFirst({ rows: filtered, selectedId: selectedSlug, getId: (a) => a.slug, select: setSelectedSlug })

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
  }, [queryClient, selectedSlug])

  const modeMut = useMutation({
    mutationFn: (mode: Mode) => callApi(`/agents-ia/${selectedSlug}`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    onSuccess: invalidate,
    onError: (e: Error) => setActionMessage({ tone: 'error', text: e.message }),
  })

  const sonderMut = useMutation({
    mutationFn: () => callApi<{ runs: RunLigne[] }>(`/agents-ia/${selectedSlug}/sonder`, { method: 'POST' }),
    onSuccess: (r) => {
      invalidate()
      setActionMessage({ tone: 'ok', text: r.runs.length ? `${r.runs.length} nouveau(x) mail(s) traité(s).` : 'Aucun nouveau mail.' })
    },
    onError: (e: Error) => { invalidate(); setActionMessage({ tone: 'error', text: e.message }) },
  })

  useEffect(() => { setActionMessage(null) }, [selectedSlug])

  return (
    <>
      <MasterDetailLayout
        list={<AgentList agents={filtered} total={agents?.length ?? 0} isLoading={isLoading} isError={isError}
          error={error as Error | null} selectedSlug={selectedSlug} onSelect={setSelectedSlug}
          searchQuery={searchQuery} onSearchChange={setSearchQuery} />}
        detailHeader={<DetailHeader agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null} canPilot={canPilot}
          onSonder={() => { setActionMessage(null); sonderMut.mutate() }} isSondant={sonderMut.isPending || !!detail?.sondage.enCours}
          onEssai={() => setEssaiOpen(true)} message={actionMessage} onDismissMessage={() => setActionMessage(null)} />}
        detail={<DetailMain agent={detail ?? null} isLoading={detailLoading && selectedSlug !== null}
          hasSelection={selectedSlug !== null} canPilot={canPilot} onOpenRun={setOpenRunId} onChanged={invalidate} />}
        sidebar={selectedSlug !== null ? <DetailSidebar agent={detail ?? null} canPilot={canPilot}
          onChangeMode={(m) => modeMut.mutate(m)} isChangingMode={modeMut.isPending} /> : null}
        sidebarTitle="Aperçu"
        hasSelection={selectedSlug !== null}
        onBack={() => setSelectedSlug(null)}
      />
      {selectedSlug && (
        <RunDialog slug={selectedSlug} runId={openRunId} canPilot={canPilot} onClose={() => setOpenRunId(null)}
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
  const sonderTitle = !canPilot ? 'Droit « Piloter les agents IA » requis'
    : agent.mode === 'off' ? 'L’agent est à l’arrêt : passez-le en essai ou en service'
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
          <Button variant="outline" size="sm" onClick={onEssai} disabled={!canPilot}
            title={canPilot ? 'Tester l’agent sur un PDF, sans rien enregistrer' : 'Droit « Piloter les agents IA » requis'}>
            <Upload className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">Tester un PDF</span>
          </Button>
          <Button variant="gold" size="sm" onClick={onSonder} disabled={!canPilot || agent.mode === 'off' || isSondant} title={sonderTitle}>
            {isSondant ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 sm:mr-1.5" />}
            <span className="hidden sm:inline">Relever maintenant</span>
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
        {activeTab === 'executions' && <ExecutionsTab slug={agent.slug} onOpenRun={onOpenRun} />}
        {activeTab === 'prompt' && <PromptTab agent={agent} canPilot={canPilot} onChanged={onChanged} />}
        {activeTab === 'couts' && <CoutsTab slug={agent.slug} />}
        {activeTab === 'fonctionnement' && <FonctionnementTab agent={agent} />}
      </div>
    </div>
  )
}

// ── Exécutions ───────────────────────────────────────────

const RUN_FILTERS: Array<{ key: string; label: string; statuts: Statut[] | null }> = [
  { key: 'tout', label: 'Toutes', statuts: null },
  { key: 'verifier', label: 'À vérifier', statuts: ['a_verifier', 'erreur'] },
  { key: 'ecrit', label: 'Enregistrées', statuts: ['ecrit'] },
  { key: 'simule', label: 'Simulées', statuts: ['simule'] },
]

function ExecutionsTab({ slug, onOpenRun }: { slug: string; onOpenRun: (id: string) => void }) {
  const [filtre, setFiltre] = useState('tout')
  const statuts = RUN_FILTERS.find((f) => f.key === filtre)?.statuts
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-runs', slug, filtre],
    queryFn: () => apiFetch<{ total: number; runs: RunLigne[] }>(`/agents-ia/${slug}/runs${statuts ? `?statut=${statuts.join(',')}` : ''}`),
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
                      {r.verdict?.valeur === 'correct' && <ThumbsUp className="h-3 w-3 text-success flex-shrink-0" />}
                      {r.verdict?.valeur === 'incorrect' && <ThumbsDown className="h-3 w-3 text-destructive flex-shrink-0" />}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">{fmtUsd(r.coutUsd, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  return (
    <>
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
          <div key={v.version} className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
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
        <KV label="Coût total" value={fmtUsd(data.totalUsd)} mono />
        <KV label="Exécutions" value={fmtNum(data.runs)} mono />
        <KV label="Coût moyen par exécution" value={fmtUsd(data.moyenneUsd)} mono />
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
                  <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(j.coutUsd)}</td>
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
        <div className="flex items-center gap-2 mb-2"><Mail className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Déclenchement</h3></div>
        <p className="text-sm text-muted-foreground">{agent.declencheur}</p>
        <p className="text-xs text-muted-foreground mt-1">
          Seuls les mails reçus après la première mise en marche sont lus
          {agent.startedAt ? ` (depuis le ${fmtDateHeure(agent.startedAt)})` : ''}.
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2"><Play className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Ce qu’il enregistre (en service)</h3></div>
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
          {agent.ecritures.map((e) => <li key={e}>{e}</li>)}
        </ul>
      </div>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
        <div className="flex items-center gap-2 mb-2"><AlertTriangle className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Quand il s’abstient</h3></div>
        <p className="text-sm text-muted-foreground">
          Rien n’est enregistré si un contrôle bloque : numéro de commande ou de bordereau illisible, commande inconnue ou pas chez MATEL,
          pièce introuvable ou affectée à une autre commande, somme des poids ou des métrages différente des totaux imprimés.
          L’exécution passe alors « à vérifier » et les abonnés à la notification « BL MATEL à vérifier » reçoivent un email
          (Paramètres › Utilisateurs › Notifications).
        </p>
      </div>
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
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
            <Info className="h-3.5 w-3.5" />Aperçu
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
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
            <KV label="Jugées correctes / incorrectes" value={`${s.verdicts.correct} / ${s.verdicts.incorrect}`} mono />
            <KV label="Coût" value={fmtUsd(s.coutUsd)} mono />
            <p className="text-[11px] text-muted-foreground pt-1">Les tests manuels ne comptent pas. Une nouvelle version repart de zéro.</p>
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Mode</p>
            <p className="text-sm">{MODE_META[agent.mode].description}</p>
            {agent.modeChangedBy && (
              <p className="text-[11px] text-muted-foreground">Changé par {agent.modeChangedBy.nom} le {fmtDateHeure(agent.modeChangedAt)}</p>
            )}
          </div>
        </div>
      </div>
      <ModeFooter current={agent.mode} onChange={onChangeMode} isChanging={isChangingMode} disabled={!canPilot} />
    </div>
  )
}

/** §29.4 multi-state status footer — the agent's mode. */
function ModeFooter({ current, onChange, isChanging, disabled }: {
  current: Mode; onChange: (m: Mode) => void; isChanging: boolean; disabled: boolean
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
          {MODE_ORDER.map((m) => {
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
                  <span className="block text-[11px] text-muted-foreground">{mm.description}</span>
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

// ── Run dialog (side-by-side §18.C) ──────────────────────

const PIECE_STATUT: Record<PieceResolue['statut'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'text-success' },
  affectee_ailleurs: { label: 'Autre commande', cls: 'text-destructive' },
  inconnue: { label: 'Introuvable', cls: 'text-destructive' },
}

function RunDialog({ slug, runId, canPilot, onClose, onOpenRun, onChanged }: {
  slug: string; runId: string | null; canPilot: boolean; onClose: () => void
  onOpenRun: (id: string) => void; onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const [showOcr, setShowOcr] = useState(false)
  const [commentaire, setCommentaire] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setPage(0); setShowOcr(false); setError(null) }, [runId])

  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunComplet>(`/agents-ia/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })
  useEffect(() => { setCommentaire(run?.verdict?.commentaire ?? '') }, [run?.id, run?.verdict?.commentaire])

  const retraiterMut = useMutation({
    mutationFn: () => callApi<{ runs: RunLigne[] }>(`/agents-ia/${slug}/runs/${runId}/retraiter`, { method: 'POST' }),
    onSuccess: (r) => { onChanged(); if (r.runs[0]) onOpenRun(r.runs[0].id) },
    onError: (e: Error) => setError(e.message),
  })
  const verdictMut = useMutation({
    mutationFn: (valeur: 'correct' | 'incorrect' | null) =>
      callApi(`/agents-ia/${slug}/runs/${runId}/verdict`, { method: 'PUT', body: JSON.stringify({ valeur, commentaire }) }),
    onSuccess: () => { onChanged(); queryClient.invalidateQueries({ queryKey: ['agent-ia-run', slug, runId] }) },
    onError: (e: Error) => setError(e.message),
  })

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
                    <div key={i} className={cn('rounded-lg border-l-4 border border-border/60 p-2.5 text-sm flex gap-2',
                      c.gravite === 'bloquant' ? 'border-l-destructive/60 bg-destructive/5 text-destructive' : 'border-l-amber-400/60 bg-amber-400/10 text-amber-800')}>
                      {c.gravite === 'bloquant' ? <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                      <span>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {run.statut === 'ecrit' && run.resultat.ecriture && (
                <div className="rounded-lg border-l-4 border-l-green-500/60 border border-border/60 bg-green-500/5 p-3 text-sm text-green-700 flex gap-2">
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{run.resultat.ecriture.lignesEcrites} pièce(s) enregistrée(s) pour la réception{run.resultat.ecriture.gedId ? ', PDF classé dans les documents de la commande' : ''}.</span>
                </div>
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
              {run.verdict && (
                <p className="text-[11px] text-muted-foreground">
                  Jugée {run.verdict.valeur === 'correct' ? 'correcte' : 'incorrecte'} par {run.verdict.par.nom} le {fmtDateHeure(run.verdict.le)}
                </p>
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
              {canPilot && (
                <div className="flex flex-wrap items-center gap-2">
                  <input value={commentaire} onChange={(ev) => setCommentaire(ev.target.value)} placeholder="Commentaire (ce qui est faux…)"
                    className="flex-1 min-w-[160px] h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
                  <Button variant="outline" size="sm" disabled={verdictMut.isPending}
                    className={cn(run.verdict?.valeur === 'correct' && 'border-success text-success')}
                    onClick={() => verdictMut.mutate(run.verdict?.valeur === 'correct' ? null : 'correct')} title="Lecture correcte">
                    <ThumbsUp className="h-3.5 w-3.5 mr-1.5" />Correct
                  </Button>
                  <Button variant="outline" size="sm" disabled={verdictMut.isPending}
                    className={cn(run.verdict?.valeur === 'incorrect' && 'border-destructive text-destructive')}
                    onClick={() => verdictMut.mutate(run.verdict?.valeur === 'incorrect' ? null : 'incorrect')} title="Lecture incorrecte">
                    <ThumbsDown className="h-3.5 w-3.5 mr-1.5" />Incorrect
                  </Button>
                  {run.fichiers.length > 0 && (
                    <Button size="sm" disabled={retraiterMut.isPending} onClick={() => retraiterMut.mutate()}
                      title="Relancer la lecture avec la version active (enregistre si l’agent est en service)">
                      {retraiterMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />}Retraiter
                    </Button>
                  )}
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
