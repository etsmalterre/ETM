// Agents IA › Automates — the « Classeur » layout (mps_designer §39), same
// shell as Agents IA › Agents: automates in the left list, master tabs in the
// center (Exécutions / État / Retours / Fonctionnement), overview in the right
// sidebar with the automate's mode as the §29.4 status footer.
//
// An automate is a DETERMINISTIC script (no LLM): its version is the code
// version, and feedback is free text per version (« Retours ») — never a score.
// API: /api/automates (apps/api/src/routes/automates.ts). Reads need only a
// session; every write needs `edit_agents_ia`, checked server-side too.
//
// Shared with TRM (imported through `@etm`, `basePath="/automates-trm"`): each
// app lists only its own automates. ETM's Vidéosurveillance (Reolink NVR push
// schedule from the TRM atelier planning) has its run and live-state views,
// VideoRun / VideoEtat; TRM's two pointage report emails (rapport-pointage,
// bilan-heures) share RapportRun.

import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  BellOff,
  BookOpen,
  Camera,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Cog,
  Eye,
  FlaskConical,
  Lock,
  History,
  Info,
  Loader2,
  Mail,
  Pencil,
  MessagesSquare,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Users,
  Workflow,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { SmartSearchInput, foldSearchText, type SearchTagDef } from '@/components/stock/SmartSearchInput'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { useUser } from '@/contexts/UserContext'
import { apiFetch, API_URL } from '@/lib/api'
import { ToggleSwitch } from './SettingsUtilisateurs'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  BaseApiProvider,
  callApi,
  fmtDateCourte,
  fmtDateHeure,
  ilYA,
  KV,
  MODE_META,
  LienErp,
  ModeFooter,
  useBaseApi,
  useLancement,
  type Lancement,
  type Mode,
  type Sondage,
} from '@/components/agents-ia/commun'
import {
  CarteRetour,
  CommentaireUtilisateur,
  EntreeRetour,
  NoteDev,
  VideRetours,
  VueRetoursBoutons,
  type VueRetours,
} from '@/components/agents-ia/retours'

// ── Types (mirror routes/automates.ts) ───────────────────

type Statut = 'applique' | 'simule' | 'inchange' | 'erreur'
type Source = 'planifie' | 'manuel' | 'arret'

interface Auteur { id: number; nom: string }

interface AutomateRun {
  id: string
  slug: string
  createdAt: string
  source: Source
  lancePar: Auteur | null
  mode: Mode
  version: number
  statut: Statut
  resume: string
  dureeMs: number
  erreur?: string
  resultat?: Record<string, unknown>
}

interface AutomateVue {
  slug: string
  nom: string
  description: string
  version: number
  versions: Array<{ version: number; date: string; note: string }>
  declencheur: string
  lit: string[]
  ecritures: string[]
  abstention: string
  modes: Partial<Record<Mode, string>>
  aUnEtat: boolean
  /** It mails subscribers: the « Destinataires » tab chooses them. */
  aDesDestinataires: boolean
  mode: Mode
  modeChangedAt: string | null
  modeChangedBy: Auteur | null
  dernierControle: { le: string; statut: Statut; resume: string } | null
  planificateurActif: boolean
  prochain: string | null
  sondage: Sondage
  stats: { executions: number; erreurs7j: number; derniereEcriture: string | null; derniereErreur: AutomateRun | null }
  retoursVersion: number
}

interface Retour {
  id: string; version: number; texte: string; par: Auteur; le: string; cible?: { libelle: string; lien?: string }
  /** A developer's note on one run, and that run's date (GET /:slug/retours). */
  runId?: string; runLe?: string | null
}

const STATUT_META: Record<Statut, { label: string; solid: string; text: string; icon: ComponentType<{ className?: string }> }> = {
  applique: { label: 'Appliqué', solid: 'bg-success border-success', text: 'text-success', icon: CheckCircle2 },
  simule: { label: 'Simulé', solid: 'bg-sky-600 border-sky-600', text: 'text-sky-700', icon: FlaskConical },
  inchange: { label: 'Inchangé', solid: 'bg-zinc-500 border-zinc-500', text: 'text-muted-foreground', icon: CircleDashed },
  erreur: { label: 'Erreur', solid: 'bg-destructive border-destructive', text: 'text-destructive', icon: XCircle },
}

const SOURCE_LABEL: Record<Source, string> = { planifie: 'Planifiée', manuel: 'Manuelle', arret: 'Arrêt' }

function StatutPill({ statut }: { statut: Statut }) {
  const m = STATUT_META[statut]
  const Icon = m.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white flex-shrink-0', m.solid)}>
      <Icon className="h-2.5 w-2.5" />{m.label}
    </Badge>
  )
}

// ── Page ─────────────────────────────────────────────────

/** `basePath`: the API router of this app's automates — ETM's by default, TRM
 *  passes `/automates-trm` (its own menu, its own automates and permissions). */
export function Automates({ basePath = '/automates' }: { basePath?: string } = {}) {
  const base = basePath
  const queryClient = useQueryClient()
  const canPilot = useHasPermission('edit_agents_ia')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const { data: automates, isLoading, isError, error } = useQuery({
    queryKey: ['automates'],
    queryFn: () => apiFetch<AutomateVue[]>(base),
    refetchInterval: 30_000,
  })

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return (automates ?? []).filter((a) => !q || a.nom.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  }, [automates, searchQuery])

  useAutoSelectFirst({ rows: automates ? filtered : undefined, selectedId: selectedSlug, getId: (a) => a.slug, select: setSelectedSlug })

  const detailKey = useMemo(() => ['automate', selectedSlug] as const, [selectedSlug])
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: detailKey,
    queryFn: () => apiFetch<AutomateVue>(`${base}/${selectedSlug}`),
    enabled: selectedSlug !== null,
    refetchInterval: 30_000,
  })

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['automates'] })
    queryClient.invalidateQueries({ queryKey: ['automate', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['automate-runs', selectedSlug] })
    queryClient.invalidateQueries({ queryKey: ['automate-etat', selectedSlug] })
  }, [queryClient, selectedSlug])

  const modeMut = useMutation({
    mutationFn: (mode: Mode) => callApi<{ automate: AutomateVue; avertissement: string | null }>(`${base}/${selectedSlug}`, { method: 'PATCH', body: JSON.stringify({ mode }) }),
    onSuccess: (r) => {
      invalidate()
      if (r.avertissement) setActionMessage({ tone: 'error', text: r.avertissement })
    },
    onError: (e: Error) => setActionMessage({ tone: 'error', text: e.message }),
  })

  const lancement = useLancement<AutomateVue>({
    detailKey,
    detailPath: selectedSlug ? `${base}/${selectedSlug}` : null,
    onFin: (l) => {
      invalidate()
      if (!l) { setActionMessage({ tone: 'error', text: 'L’exécution a été interrompue (redémarrage du serveur ?). Relancez-la.' }); return }
      if (l.erreur) setActionMessage({ tone: 'error', text: l.erreur })
      else if (l.runs[0]) setActionMessage({ tone: 'ok', text: l.runs[0].resume })
      if (l.runs[0]) setOpenRunId(l.runs[0].id)
    },
  })

  const lancerMut = useMutation({
    mutationFn: () => callApi<{ lancement: Lancement }>(`${base}/${selectedSlug}/lancer`, { method: 'POST' }),
    onSuccess: (r) => lancement.attendre(r.lancement.id),
    onError: (e: Error) => { invalidate(); setActionMessage({ tone: 'error', text: e.message }) },
  })

  useEffect(() => { setActionMessage(null); lancement.abandonner() }, [selectedSlug]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <BaseApiProvider value={base}>
      <MasterDetailLayout
        list={<AutomateList automates={filtered} total={automates?.length ?? 0} isLoading={isLoading} isError={isError}
          error={error as Error | null} selectedSlug={selectedSlug} onSelect={setSelectedSlug}
          searchQuery={searchQuery} onSearchChange={setSearchQuery} />}
        detailHeader={<DetailHeader automate={detail ?? null} isLoading={detailLoading && selectedSlug !== null} canPilot={canPilot}
          onLancer={() => { setActionMessage(null); lancerMut.mutate() }}
          isLancant={lancerMut.isPending || lancement.enAttente || !!detail?.sondage.enCours}
          message={actionMessage} onDismissMessage={() => setActionMessage(null)} />}
        detail={<DetailMain automate={detail ?? null} isLoading={detailLoading && selectedSlug !== null}
          hasSelection={selectedSlug !== null} canPilot={canPilot} onOpenRun={setOpenRunId} />}
        sidebar={selectedSlug !== null ? <DetailSidebar automate={detail ?? null} canPilot={canPilot}
          onChangeMode={(m) => modeMut.mutate(m)} isChangingMode={modeMut.isPending} onOpenRun={setOpenRunId} /> : null}
        sidebarTitle="Aperçu"
        hasSelection={selectedSlug !== null}
        onBack={() => setSelectedSlug(null)}
      />
      {selectedSlug && <RunDialog slug={selectedSlug} runId={openRunId} canPilot={canPilot} onClose={() => setOpenRunId(null)} />}
    </BaseApiProvider>
  )
}

// ── Left list ────────────────────────────────────────────

function AutomateList({ automates, total, isLoading, isError, error, selectedSlug, onSelect, searchQuery, onSearchChange }: {
  automates: AutomateVue[]; total: number; isLoading: boolean; isError: boolean; error: Error | null
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
        : automates.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><Cog className="h-12 w-12 mb-3 opacity-50" /><p className="text-sm">Aucun automate</p></div>
        : automates.map((a) => {
          const m = MODE_META[a.mode]
          const MIcon = m.icon
          const enErreur = a.dernierControle?.statut === 'erreur'
          return (
            <div key={a.slug} onClick={() => onSelect(a.slug)}
              className={cn('p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedSlug === a.slug ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')}>
              <div className="flex items-center gap-2">
                <Cog className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{a.nom}</p>
                <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white flex-shrink-0', m.solid)}>
                  <MIcon className="h-2.5 w-2.5" />{m.label}
                </Badge>
              </div>
              <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">v{a.version} · dernier contrôle {ilYA(a.dernierControle?.le)}</span>
                {enErreur && (
                  <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-destructive font-medium">
                    <AlertTriangle className="h-3 w-3" />en erreur
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{automates.length} / {total} automate{total !== 1 ? 's' : ''}</span>
      </div>
    </div>
  )
}

// ── Detail header ────────────────────────────────────────

function DetailHeader({ automate, isLoading, canPilot, onLancer, isLancant, message, onDismissMessage }: {
  automate: AutomateVue | null; isLoading: boolean; canPilot: boolean
  onLancer: () => void; isLancant: boolean
  message: { tone: 'ok' | 'error'; text: string } | null; onDismissMessage: () => void
}) {
  if (isLoading || !automate) {
    return isLoading ? <div className="flex-shrink-0 pt-0.5"><div className="h-8 w-48 bg-muted animate-pulse rounded" /></div> : null
  }
  const lancerTitle = !canPilot ? 'Droit « Piloter les agents IA et les automates » requis'
    : automate.mode === 'actif' ? 'Exécuter maintenant : applique les changements'
    : 'Exécuter maintenant en essai : montre ce qui changerait, n’écrit rien'
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-lg flex items-center justify-center icon-box-gold">
          <Cog className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{automate.nom}</h1>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            <Badge variant="secondary" className="text-xs">Version {automate.version}</Badge>
            <Badge variant="secondary" className="text-xs">Automate</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="gold" size="sm" onClick={onLancer} disabled={!canPilot || isLancant} title={lancerTitle}>
            {isLancant ? <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 sm:mr-1.5" />}
            <span className="hidden sm:inline">Lancer maintenant</span>
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
  { key: 'etat', label: 'État', icon: Eye },
  { key: 'retours', label: 'Retours', icon: MessagesSquare },
  { key: 'fonctionnement', label: 'Fonctionnement', icon: Workflow },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({ automate, isLoading, hasSelection, canPilot, onOpenRun }: {
  automate: AutomateVue | null; isLoading: boolean; hasSelection: boolean; canPilot: boolean; onOpenRun: (id: string) => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('executions')
  useEffect(() => { setActiveTab('executions') }, [automate?.slug])

  if (!hasSelection) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <div className="icon-box-gold h-16 w-16 rounded-xl flex items-center justify-center mb-3"><Cog className="h-8 w-8" /></div>
        <p className="text-sm">Sélectionnez un automate</p>
      </div>
    )
  }
  if (isLoading || !automate) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  }
  const tabs = MAIN_TABS.filter((t) => t.key !== 'etat' || automate.aUnEtat)
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2 overflow-x-auto">
        {tabs.map((t) => {
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
        {activeTab === 'executions' && <ExecutionsTab automate={automate} onOpenRun={onOpenRun} />}
        {activeTab === 'etat' && <EtatTab slug={automate.slug} />}
        {activeTab === 'retours' && <RetoursTab automate={automate} canPilot={canPilot} onOpenRun={onOpenRun} />}
        {activeTab === 'fonctionnement' && <FonctionnementTab automate={automate} />}
      </div>
    </div>
  )
}

// ── Exécutions ───────────────────────────────────────────

type RunTag = SearchTagDef<AutomateRun> & { groupe: 'Statut' | 'Source' }

const RUN_TAG_DEFS: Array<{ key: string; label: string; groupe: RunTag['groupe']; match: (r: AutomateRun) => boolean; cls: string; icon: ComponentType<{ className?: string }> }> = [
  ...(Object.keys(STATUT_META) as Statut[]).map((s) => ({
    key: s, label: STATUT_META[s].label, groupe: 'Statut' as const, match: (r: AutomateRun) => r.statut === s,
    cls: cn('text-white', STATUT_META[s].solid), icon: STATUT_META[s].icon,
  })),
  ...(Object.keys(SOURCE_LABEL) as Source[]).map((s) => ({
    key: `source-${s}`, label: SOURCE_LABEL[s], groupe: 'Source' as const, match: (r: AutomateRun) => r.source === s,
    cls: 'border-border/60 bg-zinc-100/80 text-muted-foreground', icon: s === 'manuel' ? Play : s === 'arret' ? CircleSlash : Clock,
  })),
]

/** The tags with their counts on the loaded runs. */
function runTags(runs: AutomateRun[]): RunTag[] {
  return RUN_TAG_DEFS.map((d) => ({
    key: d.key,
    label: d.label,
    groupe: d.groupe,
    predicate: d.match,
    count: runs.filter(d.match).length,
    renderPill: (trailing?: ReactNode) => {
      const Icon = d.icon
      return (
        <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', d.cls)}>
          <Icon className="h-3 w-3" />{d.label}{trailing}
        </span>
      )
    },
  }))
}

/** Tags (OR within a family, AND across), then the typed text on the summary and who launched it. */
function filtrerRuns(runs: AutomateRun[], tags: RunTag[], actifs: readonly string[], texte: string): AutomateRun[] {
  const choisis = tags.filter((t) => actifs.includes(t.key))
  const familles = (['Statut', 'Source'] as const).map((g) => choisis.filter((t) => t.groupe === g)).filter((g) => g.length > 0)
  const t = foldSearchText(texte.trim())
  return runs.filter((r) =>
    familles.every((g) => g.some((tag) => tag.predicate(r)))
    && (!t || [r.resume, r.lancePar?.nom, r.erreur].some((v) => v != null && foldSearchText(v).includes(t))))
}

/** Version selector value for « every version ». */
const TOUTES_VERSIONS = -1

/** Options of the version selector, newest first, « Toutes les versions » last when asked. */
function optionsVersions(automate: AutomateVue, toutes: boolean) {
  return [
    ...[...automate.versions].sort((a, b) => b.version - a.version).map((v) => ({
      id: v.version,
      primary: `Version ${v.version}`,
      secondary: v.version === automate.version ? 'active' : undefined,
    })),
    ...(toutes ? [{ id: TOUTES_VERSIONS, primary: 'Toutes les versions' }] : []),
  ]
}

// Same toolbar as Agents IA › Exécutions (Vincent 2026-10-30): the version,
// then one search bar whose tags filter by statut and source.
function ExecutionsTab({ automate, onOpenRun }: { automate: AutomateVue; onOpenRun: (id: string) => void }) {
  const base = useBaseApi()
  const slug = automate.slug
  // null = follow the current version.
  const [choix, setChoix] = useState<number | null>(null)
  const version = choix ?? automate.version
  const [texte, setTexte] = useState('')
  const [actifs, setActifs] = useState<string[]>([])
  const { data: tous, isLoading, isError } = useQuery({
    queryKey: ['automate-runs', slug],
    queryFn: () => apiFetch<{ runs: AutomateRun[] }>(`${base}/${slug}/runs`).then((r) => r.runs),
    refetchInterval: 30_000,
  })
  const brut = useMemo(() => (tous ?? []).filter((r) => version === TOUTES_VERSIONS || r.version === version), [tous, version])
  const tags = useMemo(() => runTags(brut), [brut])
  const runs = filtrerRuns(brut, tags, actifs, texte)

  return (
    <>
      <div className="flex items-center gap-2">
        <PopoverSelect size="sm" widthClass="w-[190px]" hideEmpty mutedSecondary options={optionsVersions(automate, true)} value={version}
          onChange={(v) => { if (v) setChoix(v === automate.version ? null : v) }} />
        <SmartSearchInput<never, AutomateRun>
          className="flex-1 min-w-0"
          value={texte}
          onValueChange={setTexte}
          tags={tags}
          activeTags={actifs}
          onActiveTagsChange={setActifs}
          placeholder="Rechercher (résumé, lancé par…) ou filtrer"
          chipPlaceholder="Rechercher…"
        />
        {tous && (
          <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
            {runs.length} exécution{runs.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex items-center gap-2 text-sm text-destructive py-4"><AlertCircle className="h-4 w-4" />Impossible de charger les exécutions.</div>
      : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <History className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">{brut.length > 0 ? 'Aucune exécution ne correspond' : version === TOUTES_VERSIONS ? 'Aucune exécution' : `Aucune exécution sur la version ${version}`}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '16%' }} /><col style={{ width: '12%' }} /><col style={{ width: '13%' }} />
              <col /><col style={{ width: '9%' }} />
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                <th className="px-3 py-2.5 text-left font-semibold">Source</th>
                <th className="px-3 py-2.5 text-left font-semibold">Statut</th>
                <th className="px-3 py-2.5 text-left font-semibold">Résumé</th>
                <th className="px-3 py-2.5 text-right font-semibold">Durée</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} onClick={() => onOpenRun(r.id)} className="border-b border-border/40 last:border-0 cursor-pointer hover:bg-accent/5 transition-colors">
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">{fmtDateCourte(r.createdAt)}</td>
                  <td className="px-3 py-2 text-muted-foreground truncate" title={r.lancePar?.nom}>
                    {SOURCE_LABEL[r.source]}{r.mode !== 'actif' && r.source !== 'arret' ? ' · essai' : ''}
                  </td>
                  <td className="px-3 py-2"><StatutPill statut={r.statut} /></td>
                  <td className="px-3 py-2 truncate" title={r.resume}>{r.resume}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(r.dureeMs / 1000, 1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── État (live, read-only) ───────────────────────────────

function EtatTab({ slug }: { slug: string }) {
  const base = useBaseApi()
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['automate-etat', slug],
    queryFn: () => callApi<{ etat: unknown }>(`${base}/${slug}/etat`).then((r) => r.etat),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  return (
    <>
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted-foreground flex-1">Lu en direct sur l’appareil, sans rien modifier.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} title="Relire l’appareil">
          <RefreshCw className={cn('h-3.5 w-3.5 sm:mr-1.5', isFetching && 'animate-spin')} /><span className="hidden sm:inline">Relire</span>
        </Button>
      </div>
      {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex items-center gap-2 text-sm text-destructive py-4"><AlertCircle className="h-4 w-4 flex-shrink-0" />{(error as Error).message}</div>
      : slug === 'videosurveillance' ? <VideoEtat etat={data as EtatVideo} />
      : <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>}
    </>
  )
}

// ── Vidéosurveillance views ──────────────────────────────

interface VueCanal {
  canal: number
  nom: string
  enable: number
  scheduleEnable: number
  /** v3: push ranges of each detection a person left on (MD, AI_PEOPLE…). */
  detections?: Record<string, string[]>
  /** v1/v2 runs: motion ranges + the other detections'. */
  md?: string
  plages?: string[]
  autres?: Record<string, string[]>
  /** v2+: push switched off by a person (v3: or every detection unticked) — left alone. Absent on v1 runs. */
  coupee?: boolean
}

/** Switched off by hand in the Reolink app (v1 runs carry no `coupee`). */
const estCoupee = (c: VueCanal) => c.coupee ?? c.enable === 0

/** Push ranges per detection left on, whatever the run version. */
function detectionsDe(c: VueCanal): Record<string, string[]> {
  if (c.detections) return c.detections
  const out: Record<string, string[]> = {}
  if (c.plages?.length) out.MD = c.plages
  return { ...out, ...(c.autres ?? {}) }
}

/** A camera's detections: one window when they all share it (the usual case
 *  once the automate has run), one line per detection otherwise. */
function Detections({ c }: { c: VueCanal }) {
  const d = Object.entries(detectionsDe(c)).sort(([a], [b]) => ORDRE_EVENEMENTS.indexOf(a) - ORDRE_EVENEMENTS.indexOf(b))
  if (!d.length) return <span className="text-muted-foreground italic">aucune détection</span>
  if (d.every(([, p]) => p.join() === d[0][1].join())) {
    return (
      <>
        <Plages plages={d[0][1]} />
        <p className="text-[11px] text-muted-foreground mt-1">{d.map(([e]) => EVENEMENTS[e] ?? e).join(', ')}</p>
      </>
    )
  }
  return (
    <div className="space-y-1">
      {d.map(([evt, p]) => (
        <div key={evt} className="flex items-baseline gap-2">
          <span className="text-[11px] text-muted-foreground flex-shrink-0 w-16">{EVENEMENTS[evt] ?? evt}</span>
          <Plages plages={p} />
        </div>
      ))}
    </div>
  )
}

function CoupeeNote() {
  return (
    <p className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
      <BellOff className="h-3 w-3 flex-shrink-0" />Coupée à la main — laissée telle quelle
    </p>
  )
}

interface EtatVideo {
  lu: string
  cible: { md: string; plages: string[]; semainesNonPlanifiees: string[] }
  fixe: string[]
  cameras: Array<VueCanal & { conforme: boolean }>
}

const EVENEMENTS: Record<string, string> = { AI_PEOPLE: 'Personne', AI_VEHICLE: 'Véhicule', AI_DOG_CAT: 'Animal', MD: 'Mouvement' }
const ORDRE_EVENEMENTS = ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT']
const fmtLundi = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function Plages({ plages, vide = 'jamais' }: { plages: string[]; vide?: string }) {
  if (!plages.length) return <span className="text-muted-foreground italic">{vide}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {plages.map((p) => (
        <span key={p} className="inline-flex items-center rounded-md border border-border/60 bg-zinc-100 px-1.5 py-0.5 text-xs tabular-nums whitespace-nowrap">{p}</span>
      ))}
    </span>
  )
}

function CibleCard({ cible, titre }: { cible: EtatVideo['cible']; titre: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
      <div className="flex items-center gap-2 mb-2"><Clock className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">{titre}</h3></div>
      <Plages plages={cible.plages} vide="aucune alerte" />
      {cible.semainesNonPlanifiees.length > 0 && (
        <p className="flex items-start gap-1.5 mt-2 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>Semaine du {cible.semainesNonPlanifiees.map(fmtLundi).join(', du ')} sans planning : planning fixe (vendredi 18 h → lundi 5 h).</span>
        </p>
      )}
    </div>
  )
}

function VideoEtat({ etat }: { etat: EtatVideo }) {
  const ecarts = etat.cameras.filter((c) => !c.conforme).length
  const coupees = etat.cameras.filter(estCoupee)
  const suivies = etat.cameras.length - coupees.length
  return (
    <>
      <CibleCard cible={etat.cible} titre="Alertes demandées par le planning (7 prochains jours)" />
      <div className={cn('flex items-center gap-2 text-sm rounded-md px-3 py-1.5',
        ecarts ? 'bg-amber-500/10 text-amber-800' : 'bg-success/10 text-success')}>
        {ecarts ? <AlertTriangle className="h-4 w-4 flex-shrink-0" /> : <CheckCircle2 className="h-4 w-4 flex-shrink-0" />}
        {ecarts
          ? `${ecarts} caméra(s) sur ${suivies} ne suivent pas encore le planning.`
          : suivies === etat.cameras.length ? `Les ${suivies} caméras suivent le planning.` : `${suivies} caméra(s) sur ${etat.cameras.length} suivent le planning.`}
        <span className="ml-auto text-xs opacity-70">lu {ilYA(etat.lu)}</span>
      </div>
      {coupees.length > 0 && (
        <div className="flex items-center gap-2 text-sm rounded-md px-3 py-1.5 bg-zinc-200/60 text-muted-foreground">
          <BellOff className="h-4 w-4 flex-shrink-0" />
          <span>Notifications (ou toutes les détections) coupées à la main dans l’application Reolink, l’automate n’y touche pas : {coupees.map((c) => c.nom).join(', ')}.</span>
        </div>
      )}
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-200/60 border-b border-border/60">
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2.5 text-left font-semibold">Caméra</th>
              <th className="px-3 py-2.5 text-left font-semibold">Alertes sur le NVR</th>
              <th className="px-3 py-2.5 text-right font-semibold">Planning</th>
            </tr>
          </thead>
          <tbody>
            {etat.cameras.map((c) => (
              <tr key={c.canal} className="border-b border-border/40 last:border-0 align-top">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2"><Camera className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" /><span className="font-medium">{c.nom}</span></div>
                  {estCoupee(c) ? <CoupeeNote /> : !c.scheduleEnable && <p className="text-[11px] text-destructive mt-0.5">Planning désactivé</p>}
                </td>
                <td className="px-3 py-2">
                  <Detections c={c} />
                </td>
                <td className="px-3 py-2 text-right">
                  {estCoupee(c)
                    ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><BellOff className="h-3.5 w-3.5" />ignorée</span>
                    : c.conforme
                    ? <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" />à jour</span>
                    : <span className="inline-flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />différent</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">Planning fixe (avant l’automate, repris pour une semaine sans planning) : {etat.fixe.join(', ')}.</p>
    </>
  )
}

interface ResultatVideo {
  planning?: { postes: Array<{ debut: string; fin: string }> }
  cible?: EtatVideo['cible']
  canaux?: Array<VueCanal & { change: boolean }>
}

function VideoRun({ run }: { run: AutomateRun }) {
  const r = (run.resultat ?? {}) as ResultatVideo
  const changes = r.canaux?.filter((c) => c.change) ?? []
  const fmtPoste = (iso: string) => new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <>
      {r.cible && <CibleCard cible={r.cible} titre={run.source === 'arret' ? 'Planning remis' : 'Alertes demandées par le planning'} />}
      {r.canaux && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-2">
            <Camera className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Caméras</h3>
            <span className="ml-auto text-xs text-muted-foreground">{changes.length} à changer sur {r.canaux.length}</span>
          </div>
          {changes.length === 0 ? <p className="text-sm text-muted-foreground italic">Toutes déjà à jour.</p> : (
            <ul className="space-y-2">
              {changes.map((c) => (
                <li key={c.canal} className="text-sm">
                  <p className="font-medium">{c.nom}</p>
                  <div className="flex items-baseline gap-2 text-xs mt-0.5">
                    <span className="text-muted-foreground flex-shrink-0 w-12">avant</span>
                    <Detections c={c} />
                  </div>
                  {(!c.enable || !c.scheduleEnable) && <p className="text-[11px] text-muted-foreground ml-14">{!c.enable ? 'notifications coupées' : 'planning désactivé'}</p>}
                </li>
              ))}
            </ul>
          )}
          {changes.length > 0 && r.canaux.some((c) => !c.change && !estCoupee(c)) && (
            <p className="text-[11px] text-muted-foreground mt-2">Déjà à jour : {r.canaux.filter((c) => !c.change && !estCoupee(c)).map((c) => c.nom).join(', ')}.</p>
          )}
          {r.canaux.some((c) => !c.change && estCoupee(c)) && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground mt-2">
              <BellOff className="h-3 w-3 flex-shrink-0" />
              Coupées à la main, laissées telles quelles : {r.canaux.filter((c) => !c.change && estCoupee(c)).map((c) => c.nom).join(', ')}.
            </p>
          )}
        </div>
      )}
      {r.planning && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-2"><BookOpen className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Équipes planifiées lues ({r.planning.postes.length})</h3></div>
          {r.planning.postes.length === 0 ? <p className="text-sm text-muted-foreground italic">Aucune.</p> : (
            <ul className="text-xs text-muted-foreground grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
              {r.planning.postes.map((p, i) => <li key={i}>{fmtPoste(p.debut)} → {fmtPoste(p.fin)}</li>)}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

interface ResultatRapport {
  sujet?: string
  apercu?: string
  destinataires?: string[]
  envoyes?: string[]
  echecs?: string[]
  ecartes?: Array<{ nom: string; raison: string }>
}

/** A pointage report run: subject, one-line summary, who got it. Never the
 *  report body (the salariés' hours) — the API does not keep it. */
function RapportRun({ run }: { run: AutomateRun }) {
  const r = (run.resultat ?? {}) as ResultatRapport
  const echecs = new Set(r.echecs ?? [])
  const envoye = run.mode === 'actif' && run.source !== 'arret'
  if (!r.sujet && !r.destinataires?.length && !r.ecartes?.length) return null
  return (
    <>
      {r.sujet && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-1"><Mail className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold truncate">{r.sujet}</h3></div>
          {r.apercu && <p className="text-sm text-muted-foreground">{r.apercu}</p>}
        </div>
      )}
      {(r.destinataires || r.ecartes) && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-2">
            <Send className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Destinataires</h3>
            <span className="ml-auto text-xs text-muted-foreground">{r.destinataires?.length ?? 0}</span>
          </div>
          {!r.destinataires?.length ? <p className="text-sm text-muted-foreground italic">Aucun abonné autorisé.</p> : (
            <ul className="space-y-1">
              {r.destinataires.map((a) => (
                <li key={a} className="flex items-center gap-2 text-sm">
                  <span className="truncate">{a}</span>
                  {envoye && r.envoyes && (echecs.has(a)
                    ? <span className="ml-auto flex items-center gap-1 text-xs text-destructive flex-shrink-0"><XCircle className="h-3.5 w-3.5" />échec</span>
                    : <span className="ml-auto flex items-center gap-1 text-xs text-success flex-shrink-0"><CheckCircle2 className="h-3.5 w-3.5" />envoyé</span>)}
                </li>
              ))}
            </ul>
          )}
          {!!r.ecartes?.length && (
            <p className="flex items-start gap-1 text-[11px] text-muted-foreground mt-2">
              <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
              <span>Abonnés écartés : {r.ecartes.map((e) => `${e.nom} (${e.raison})`).join(', ')}. Les abonnements se gèrent dans l’onglet « Destinataires ».</span>
            </p>
          )}
        </div>
      )}
    </>
  )
}

// ── Run dialog (§18.D banded « bilan ») ──────────────────

// ── Point sous-traitant run (Vincent 2026-10-30) ─────────
// What the automate proposed and what the person did with it, line by line:
// the point as it stands now (GET /:slug/runs/:id `detail`, read from
// point_sst). An essai run shows its proposal, nothing was saved.

/** Mirror of lib/point-sst/regles.ts SECTIONS (short titles). */
const SECTIONS_POINT: Record<number, string> = { 1: 'Sorties prévues', 2: 'Contrôles', 3: 'Soumissions', 4: 'Métrages', 5: 'Délais', 6: 'Études' }

interface ChampsPoint { commande: string; reference: string; coloris: string; datePrevue: string | null; commentaire: string }
interface LignePointRun extends ChampsPoint {
  id: number
  section: number
  origine: 'auto' | 'manuel'
  pourquoi: string
  auto: ChampsPoint | null
  modifiee: boolean
  retiree: boolean
  retour: { id: string; texte: string; par: string | null } | null
  modifieLe: string | null
  modifiePar: string | null
}
interface PointRun {
  id: number
  sousTraitant: string
  jour: string
  statut: 'brouillon' | 'programme' | 'envoye'
  envoiPrevuLe: string | null
  programmePar: string | null
  envoyeLe: string | null
  envoyePar: string | null
  lignes: LignePointRun[]
}
interface DetailPointSst { points: Array<{ id: number; point: PointRun | null }> }
interface PropositionEssai { jour: string; lignes: Array<{ section: number; commande: string; reference: string; coloris: string; commentaire: string; pourquoi: string }> }

const jjmmPoint = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** « 9013 · 3560/3 · violet · 03/11 », the fields that are filled. */
const identite = (c: Pick<ChampsPoint, 'commande' | 'reference' | 'coloris'> & { datePrevue?: string | null }) =>
  [c.commande, c.reference, c.coloris, c.datePrevue ? jjmmPoint(c.datePrevue) : ''].filter(Boolean).join(' · ')

function PointSstRun({ run, detail }: { run: AutomateRun; detail: DetailPointSst | null }) {
  const proposes = (run.resultat?.proposes as PropositionEssai[] | undefined) ?? []
  const points = detail?.points ?? []
  if (proposes.length === 0 && points.length === 0) return null
  return (
    <>
      {proposes.map((p, i) => (
        <div key={`essai-${i}`} className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-3">
          <p className="text-sm font-semibold">Point du {jjmmPoint(p.jour)} proposé <span className="font-normal text-muted-foreground">· essai, rien n’a été enregistré</span></p>
          {Object.keys(SECTIONS_POINT).map(Number).filter((s) => p.lignes.some((l) => l.section === s)).map((s) => (
            <SectionPoint key={s} section={s}>
              {p.lignes.filter((l) => l.section === s).map((l, j) => (
                <li key={j} className="py-1.5 space-y-0.5">
                  <p className="text-sm"><span className="font-medium tabular-nums">{identite(l)}</span>{l.commentaire && <span> : {l.commentaire}</span>}</p>
                  {l.pourquoi && <p className="text-[11px] text-muted-foreground">{l.pourquoi}</p>}
                </li>
              ))}
            </SectionPoint>
          ))}
        </div>
      ))}
      {points.map(({ id, point }) => point
        ? <PointDetail key={id} point={point} />
        : <p key={id} className="text-xs text-muted-foreground italic">Le point {id} n’existe plus.</p>)}
    </>
  )
}

function PointDetail({ point }: { point: PointRun }) {
  const auto = point.lignes.filter((l) => l.origine === 'auto')
  const n = {
    proposees: auto.length,
    corrigees: auto.filter((l) => l.modifiee && !l.retiree).length,
    retirees: auto.filter((l) => l.retiree).length,
    ajoutees: point.lignes.filter((l) => l.origine === 'manuel').length,
  }
  const etat = point.statut === 'envoye'
    ? `envoyé${point.envoyeLe ? ` le ${fmtDateHeure(point.envoyeLe)}` : ''}${point.envoyePar ? ` par ${point.envoyePar}` : ''}`
    : point.statut === 'programme'
    ? `programmé${point.envoiPrevuLe ? ` pour le ${fmtDateHeure(point.envoiPrevuLe)}` : ''}${point.programmePar ? ` par ${point.programmePar}` : ''}`
    : 'en brouillon'
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold truncate">Point du {jjmmPoint(point.jour)} · {point.sousTraitant}</p>
          <LienErp to="/sous-traitants/point" className="ml-auto flex-shrink-0 text-xs text-accent hover:underline">Ouvrir le point</LienErp>
        </div>
        <p className="text-xs text-muted-foreground">
          {etat} · {n.proposees} ligne{n.proposees !== 1 ? 's' : ''} proposée{n.proposees !== 1 ? 's' : ''} par l’automate, {n.corrigees} corrigée{n.corrigees !== 1 ? 's' : ''}, {n.retirees} retirée{n.retirees !== 1 ? 's' : ''}, {n.ajoutees} ajoutée{n.ajoutees !== 1 ? 's' : ''} à la main
        </p>
      </div>
      {Object.keys(SECTIONS_POINT).map(Number).filter((s) => point.lignes.some((l) => l.section === s)).map((s) => (
        <SectionPoint key={s} section={s}>
          {point.lignes.filter((l) => l.section === s).map((l) => <LignePointDetail key={l.id} l={l} />)}
        </SectionPoint>
      ))}
    </div>
  )
}

function SectionPoint({ section, children }: { section: number; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{section}. {SECTIONS_POINT[section]}</p>
      <ul className="divide-y divide-border/40">{children}</ul>
    </div>
  )
}

/** One line: as sent, then what the person did to the automate's proposal. */
function LignePointDetail({ l }: { l: LignePointRun }) {
  const qui = [l.modifiePar, l.modifieLe ? fmtDateHeure(l.modifieLe) : ''].filter(Boolean).join(', ')
  // A corrected line: the automate's fields that differ, struck through.
  const avant = l.origine === 'auto' && l.modifiee && l.auto
    ? (['commande', 'reference', 'coloris', 'datePrevue', 'commentaire'] as const).filter((k) => (l.auto![k] ?? '') !== (l[k] ?? ''))
    : []
  return (
    <li className="py-2 space-y-1">
      <div className="flex items-start gap-2">
        <p className={cn('text-sm min-w-0 flex-1', l.retiree && 'line-through text-muted-foreground')}>
          <span className="font-medium tabular-nums">{identite(l)}</span>{l.commentaire && <span> : {l.commentaire}</span>}
        </p>
        {l.retiree ? <EtiquetteLigne icon={CircleSlash} label="Retirée" />
          : l.origine === 'manuel' ? <EtiquetteLigne icon={Plus} label="Ajoutée à la main" />
          : l.modifiee ? <EtiquetteLigne icon={Pencil} label="Corrigée" />
          : null}
      </div>
      {avant.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Proposé : <span className="line-through">{avant.map((k) => (k === 'datePrevue' ? (l.auto!.datePrevue ? jjmmPoint(l.auto!.datePrevue) : 'sans date') : l.auto![k] || 'vide')).join(' · ')}</span>
        </p>
      )}
      {l.pourquoi && l.origine === 'auto' && <p className="text-[11px] text-muted-foreground">Pourquoi l’automate l’a mise : {l.pourquoi}</p>}
      {(l.retiree || l.modifiee || l.origine === 'manuel') && qui && <p className="text-[11px] text-muted-foreground">{l.retiree ? 'Retirée' : l.origine === 'manuel' ? 'Ajoutée' : 'Corrigée'} par {qui}</p>}
      {l.retour && <CommentaireUtilisateur>{l.retour.par ? `${l.retour.par} : ` : ''}{l.retour.texte}</CommentaireUtilisateur>}
    </li>
  )
}

function EtiquetteLigne({ icon: Icon, label }: { icon: ComponentType<{ className?: string }>; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-zinc-100/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap flex-shrink-0">
      <Icon className="h-3 w-3" />{label}
    </span>
  )
}

// ── Notes on a run (the developer's, for the next version) ──

function NotesRun({ slug, run, notes, canPilot }: { slug: string; run: AutomateRun; notes: Retour[]; canPilot: boolean }) {
  const base = useBaseApi()
  const queryClient = useQueryClient()
  const [texte, setTexte] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const ajouterMut = useMutation({
    mutationFn: () => callApi(`${base}/${slug}/runs/${run.id}/retours`, { method: 'POST', body: JSON.stringify({ texte }) }),
    onSuccess: () => {
      setTexte('')
      setErreur(null)
      queryClient.invalidateQueries({ queryKey: ['automate-run', slug, run.id] })
      queryClient.invalidateQueries({ queryKey: ['automate-retours', slug] })
      queryClient.invalidateQueries({ queryKey: ['automate', slug] })
    },
    onError: (e: Error) => setErreur(e.message),
  })
  if (!canPilot && notes.length === 0) return null
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-3">
      <p className="text-sm font-semibold">Notes pour la version suivante</p>
      {notes.map((n) => (
        <EntreeRetour key={n.id} par={n.par} le={n.le}>
          <NoteDev>{n.texte}</NoteDev>
        </EntreeRetour>
      ))}
      {canPilot && (
        <div className="space-y-2">
          <textarea rows={2} value={texte} onChange={(e) => setTexte(e.target.value)} className={textareaClass}
            placeholder="Ce que la prochaine version doit faire autrement sur ce point…" />
          <div className="flex items-center gap-2">
            {erreur && <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{erreur}</span>}
            <Button size="sm" className="ml-auto" disabled={!texte.trim() || ajouterMut.isPending} onClick={() => ajouterMut.mutate()}>
              {ajouterMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}Enregistrer
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function RunDialog({ slug, runId, canPilot, onClose }: { slug: string; runId: string | null; canPilot: boolean; onClose: () => void }) {
  const base = useBaseApi()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['automate-run', slug, runId],
    queryFn: () => apiFetch<{ run: AutomateRun; detail: unknown; notes?: Retour[] }>(`${base}/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })
  const run = data?.run
  const m = run ? STATUT_META[run.statut] : null
  const Icon = m?.icon ?? History
  return (
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className={cn('p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col', slug === 'point-sst' ? 'max-w-4xl' : 'max-w-2xl')}>
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
              Exécution {run ? `du ${fmtDateHeure(run.createdAt)}` : ''}
            </h2>
            {run && (
              <p className="text-xs text-white/70 truncate">
                {SOURCE_LABEL[run.source]}{run.lancePar ? ` par ${run.lancePar.nom}` : ''} · mode {MODE_META[run.mode].label.toLowerCase()} · version {run.version} · {fmtNum(run.dureeMs / 1000, 1)} s
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
          {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          : isError || !run || !m ? <div className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />Exécution introuvable.</div>
          : (
            <>
              <div className={cn('rounded-lg border border-border/60 border-l-4 bg-card p-3 shadow-sm',
                run.statut === 'erreur' ? 'border-l-destructive/60' : run.statut === 'applique' ? 'border-l-green-500/60' : run.statut === 'simule' ? 'border-l-sky-500/60' : 'border-l-border')}>
                <div className="flex items-center gap-2 mb-1"><StatutPill statut={run.statut} /></div>
                <p className={cn('text-sm', run.statut === 'erreur' && 'text-destructive')}>{run.resume}</p>
                {run.mode !== 'actif' && run.source !== 'arret' && run.statut !== 'erreur' && (
                  <p className="text-[11px] text-muted-foreground mt-1">Essai : rien n’a été écrit ni envoyé.</p>
                )}
              </div>
              {slug === 'videosurveillance' && <VideoRun run={run} />}
              {(slug === 'rapport-pointage' || slug === 'bilan-heures') && <RapportRun run={run} />}
              {slug === 'point-sst' && <PointSstRun run={run} detail={data?.detail as DetailPointSst | null} />}
              <NotesRun slug={slug} run={run} notes={data?.notes ?? []} canPilot={canPilot} />
            </>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center border-t border-border/60 bg-zinc-200 px-4 py-3 rounded-b-lg">
          <Button variant="outline" className="ml-auto" onClick={onClose}>Fermer</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Destinataires (sidebar tab, automates that mail subscribers) ──
// Who receives the e-mail, chosen here since 2026-10-02 (TRM's pointage
// reports were chosen in Paramètres › Utilisateurs › Notifications before).
// The API lists who may receive it (`regle` says the condition) plus anyone
// still subscribed without the right, so they can be switched off. Switches
// need `edit_agents_ia`; « Voir l’e-mail » and « M’envoyer un test » need the right
// to read the report itself (`peutLire`), checked by the API too.

interface CandidatDestinataire { id: number; nom: string; email: string | null; abonne: boolean; autorise: boolean }
interface VueDestinataires { regle: string; candidats: CandidatDestinataire[]; peutLire: boolean }

function DestinatairesPanel({ slug, canPilot }: { slug: string; canPilot: boolean }) {
  const base = useBaseApi()
  const queryClient = useQueryClient()
  const [erreur, setErreur] = useState<string | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => { setErreur(null); setTest(null) }, [slug])
  const key = ['automate-destinataires', slug]
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<VueDestinataires>(`${base}/${slug}/destinataires`),
    // Who may be listed is granted elsewhere (Paramètres › Utilisateurs ›
    // Écrans): never trust the app-wide 5 min staleTime here, refetch on every
    // opening of the tab and on window focus.
    staleTime: 0,
  })
  const changerMut = useMutation({
    mutationFn: ({ id, abonne }: { id: number; abonne: boolean }) =>
      callApi<{ candidats: CandidatDestinataire[] }>(`${base}/${slug}/destinataires/${id}`, { method: 'PUT', body: JSON.stringify({ abonne }) }),
    onSuccess: (r) => {
      setErreur(null)
      queryClient.setQueryData<VueDestinataires>(key, (v) => (v ? { ...v, candidats: r.candidats } : v))
    },
    onError: (e: Error) => setErreur(e.message),
  })
  const testMut = useMutation({
    mutationFn: () => callApi<{ envoye: string }>(`${base}/${slug}/envoyer-test`, { method: 'POST' }),
    onSuccess: (r) => setTest({ ok: true, message: `Test envoyé à ${r.envoye}.` }),
    onError: (e: Error) => setTest({ ok: false, message: e.message }),
  })

  if (isLoading) return <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
  if (isError || !data) return <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />Impossible de charger les destinataires.</p>
  const abonnes = data.candidats.filter((c) => c.abonne).length

  return (
    <>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
          <Send className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Abonnés</h3>
          <Badge variant="secondary" className="ml-auto text-xs tabular-nums">{abonnes}/{data.candidats.length}</Badge>
        </div>
        {!data.candidats.length ? (
          <p className="px-3 py-4 text-sm text-muted-foreground italic">Aucun compte ne peut recevoir cet e-mail.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.candidats.map((c) => {
              const verrou = !c.autorise && !c.abonne
              const disabled = !canPilot || verrou || changerMut.isPending
              return (
                <li key={c.id}>
                  <label className={cn('flex items-center gap-2.5 px-3 py-2', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent/5')}>
                    <ToggleSwitch checked={c.abonne} disabled={disabled} onChange={(abonne) => changerMut.mutate({ id: c.id, abonne })} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{c.nom}</p>
                      {c.email
                        ? <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                        : <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3 flex-shrink-0" />Pas d’adresse e-mail : ne recevra rien</p>}
                      {!c.autorise && (
                        <p className="text-xs text-amber-800 flex items-center gap-1" title="Ce compte n’a plus le droit de lire ce rapport : il est écarté à chaque envoi.">
                          <Lock className="h-3 w-3 flex-shrink-0" />N’a plus le droit : écarté à chaque envoi
                        </p>
                      )}
                    </div>
                    {changerMut.isPending && changerMut.variables?.id === c.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent flex-shrink-0" />}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <div className="px-3 py-2.5 border-t border-border/60 space-y-1">
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3 flex-shrink-0 mt-0.5" /><span>{data.regle}</span>
          </p>
          {!canPilot && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3 flex-shrink-0 mt-0.5" /><span>Choisir les destinataires demande le droit de piloter les automates.</span>
            </p>
          )}
          {erreur && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{erreur}</p>}
        </div>
      </div>

      {data.peutLire && (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
          <div className="flex items-center gap-2 mb-1"><Mail className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">L’e-mail d’aujourd’hui</h3></div>
          <p className="text-xs text-muted-foreground mb-2">Tel qu’il partirait maintenant. Le test part à votre adresse seulement, même en essai.</p>
          <div className="flex flex-wrap items-center gap-1">
            <a href={`${API_URL}${base}/${slug}/apercu`} target="_blank" rel="noreferrer"
              className="inline-flex items-center h-8 px-3 text-xs font-medium rounded-md transition-colors hover:bg-accent/10 hover:text-accent">
              <Eye className="h-3.5 w-3.5 mr-1.5" />Voir l’e-mail
            </a>
            <Button variant="ghost" size="sm" className="h-8 text-xs hover:bg-accent/10 hover:text-accent" disabled={testMut.isPending}
              onClick={() => { setTest(null); testMut.mutate() }}>
              {testMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}M’envoyer un test
            </Button>
            {test && <span className={cn('text-xs ml-1', test.ok ? 'text-success' : 'text-destructive')}>{test.message}</span>}
          </div>
        </div>
      )}
    </>
  )
}

// ── Retours (free-text feedback per version) ─────────────

const textareaClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

// Same layout as Agents IA › Retours (Vincent 2026-10-30), one version at a
// time: « Utilisateurs » = the retours given where the work is done (a line of
// Sous-traitants › Point: they carry a `cible`), « Développeur » = the notes
// typed here, with the form to add one on the current version.
function RetoursTab({ automate, canPilot, onOpenRun }: { automate: AutomateVue; canPilot: boolean; onOpenRun: (id: string) => void }) {
  const base = useBaseApi()
  const queryClient = useQueryClient()
  const { user } = useUser()
  const [choix, setChoix] = useState<number | null>(null)
  const version = choix ?? automate.version
  const [vue, setVue] = useState<VueRetours>('utilisateurs')
  const [erreur, setErreur] = useState<string | null>(null)
  const [aSupprimer, setASupprimer] = useState<Retour | null>(null)
  const key = ['automate-retours', automate.slug]
  const { data: retours, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ retours: Retour[] }>(`${base}/${automate.slug}/retours`).then((r) => r.retours),
  })
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key })
    queryClient.invalidateQueries({ queryKey: ['automate', automate.slug] })
  }
  const supprimerMut = useMutation({
    mutationFn: (id: string) => callApi(`${base}/${automate.slug}/retours/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setASupprimer(null); refresh() },
    onError: (e: Error) => { setASupprimer(null); setErreur(e.message) },
  })
  // Newest first.
  const deVersion = (retours ?? []).filter((r) => r.version === version).sort((a, b) => b.le.localeCompare(a.le))
  const utilisateurs = deVersion.filter((r) => r.cible)
  const developpeur = deVersion.filter((r) => !r.cible)
  const supprimer = (r: Retour) => canPilot && user?.IDutilisateur === r.par.id && (
    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
      title="Supprimer ce retour" onClick={(e) => { e.stopPropagation(); setASupprimer(r) }}>
      <Trash2 className="h-3 w-3" />
    </Button>
  )

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PopoverSelect size="sm" widthClass="w-[190px]" hideEmpty mutedSecondary options={optionsVersions(automate, false)} value={version}
          onChange={(v) => { if (v) setChoix(v === automate.version ? null : v) }} />
        <VueRetoursBoutons vue={vue} onChange={setVue}
          nombres={retours ? { utilisateurs: utilisateurs.length, developpeur: developpeur.length } : null} />
        {erreur && <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{erreur}</span>}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : vue === 'utilisateurs' ? (
        <div className="space-y-3 pt-1">
          {utilisateurs.length === 0 && <VideRetours texte={`Aucun retour utilisateur sur la version ${version}`} />}
          {utilisateurs.map((r) => (
            <CarteRetour key={r.id}
              contexte={r.cible && (r.cible.lien
                ? <LienErp to={r.cible.lien} className="hover:underline hover:text-accent">{r.cible.libelle}</LienErp>
                : r.cible.libelle)}>
              <EntreeRetour par={r.par} le={r.le} actions={supprimer(r)}>
                <CommentaireUtilisateur>{r.texte}</CommentaireUtilisateur>
              </EntreeRetour>
            </CarteRetour>
          ))}
        </div>
      ) : (
        <div className="space-y-3 pt-1">
          {developpeur.length === 0 && <VideRetours texte={`Aucune note sur la version ${version}`} />}
          {developpeur.map((r) => (
            <CarteRetour key={r.id} onOpen={r.runId ? () => onOpenRun(r.runId!) : undefined}
              contexte={r.runId ? (r.runLe ? `Exécution du ${fmtDateCourte(r.runLe)}` : 'Exécution') : undefined}>
              <EntreeRetour par={r.par} le={r.le} actions={supprimer(r)}>
                <NoteDev>{r.texte}</NoteDev>
              </EntreeRetour>
            </CarteRetour>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={aSupprimer !== null}
        title="Supprimer le retour"
        description="Ce retour ne servira plus à écrire la prochaine version."
        isPending={supprimerMut.isPending}
        onCancel={() => setASupprimer(null)}
        onConfirm={() => { if (aSupprimer) supprimerMut.mutate(aSupprimer.id) }}
      />
    </>
  )
}

// ── Fonctionnement ───────────────────────────────────────

function FonctionnementTab({ automate }: { automate: AutomateVue }) {
  const Carte = ({ icon: Icon, titre, children }: { icon: ComponentType<{ className?: string }>; titre: string; children: React.ReactNode }) => (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3">
      <div className="flex items-center gap-2 mb-2"><Icon className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">{titre}</h3></div>
      {children}
    </div>
  )
  return (
    <>
      <Carte icon={Info} titre="Rôle"><p className="text-sm text-muted-foreground">{automate.description}</p></Carte>
      <Carte icon={Clock} titre="Déclenchement"><p className="text-sm text-muted-foreground">{automate.declencheur}</p></Carte>
      <Carte icon={BookOpen} titre="Ce qu’il lit">
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">{automate.lit.map((e) => <li key={e}>{e}</li>)}</ul>
      </Carte>
      <Carte icon={Play} titre="Ce qu’il écrit (en service)">
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">{automate.ecritures.map((e) => <li key={e}>{e}</li>)}</ul>
      </Carte>
      <Carte icon={AlertTriangle} titre="Quand il s’abstient"><p className="text-sm text-muted-foreground">{automate.abstention}</p></Carte>
    </>
  )
}

// ── Right sidebar ────────────────────────────────────────

const SIDE_TABS = [
  { key: 'apercu', label: 'Aperçu', icon: Info },
  { key: 'destinataires', label: 'Destinataires', icon: Users },
] as const

function DetailSidebar({ automate, canPilot, onChangeMode, isChangingMode, onOpenRun }: {
  automate: AutomateVue | null; canPilot: boolean; onChangeMode: (m: Mode) => void; isChangingMode: boolean; onOpenRun: (id: string) => void
}) {
  // « Destinataires » sits here, not in the center: a short settings list
  // attached to the automate, like a fiche's contacts (§8), next to its mode.
  const [onglet, setOnglet] = useState<'apercu' | 'destinataires'>('apercu')
  useEffect(() => { setOnglet('apercu') }, [automate?.slug])
  if (!automate) {
    return (
      <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  const s = automate.stats
  const dc = automate.dernierControle
  const version = automate.versions.find((v) => v.version === automate.version)
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {SIDE_TABS.filter((t) => t.key === 'apercu' || automate.aDesDestinataires).map((t) => {
            const Icon = t.icon
            const actif = (automate.aDesDestinataires ? onglet : 'apercu') === t.key
            return (
              <button key={t.key} type="button" onClick={() => setOnglet(t.key)}
                className={cn('flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  actif ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10')}>
                <Icon className="h-3.5 w-3.5" />{t.label}
              </button>
            )
          })}
        </div>
        {automate.aDesDestinataires && onglet === 'destinataires' ? (
          <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
            <DestinatairesPanel slug={automate.slug} canPilot={canPilot} />
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Contrôles</p>
            <KV label="Dernier contrôle" value={ilYA(dc?.le)} />
            {dc && <KV label="Résultat" value={<span className={STATUT_META[dc.statut].text}>{STATUT_META[dc.statut].label}</span>} />}
            <KV label="Prochain" value={automate.mode === 'off' ? 'automate à l’arrêt' : automate.planificateurActif ? fmtDateHeure(automate.prochain) : 'pas en production'} />
            <KV label="Dernière écriture" value={s.derniereEcriture ? fmtDateHeure(s.derniereEcriture) : 'jamais'} />
            <KV label="Erreurs (7 jours)" value={<span className={cn(s.erreurs7j > 0 && 'text-destructive font-semibold')}>{fmtNum(s.erreurs7j)}</span>} mono />
            {s.derniereErreur && (
              <button type="button" onClick={() => onOpenRun(s.derniereErreur!.id)}
                className="flex items-start gap-1.5 mt-1 text-xs text-destructive text-left hover:underline">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>Dernière erreur {fmtDateCourte(s.derniereErreur.createdAt)} : {s.derniereErreur.resume}</span>
              </button>
            )}
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Cog className="h-3.5 w-3.5" />Version {automate.version}</p>
            {version && <p className="text-sm text-muted-foreground">{version.note}</p>}
            <KV label="Retours sur cette version" value={fmtNum(automate.retoursVersion)} mono />
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Clock className="h-3.5 w-3.5" />Mode</p>
            <p className="text-sm">{automate.modes[automate.mode]}</p>
            {automate.modeChangedBy && (
              <p className="text-[11px] text-muted-foreground">Changé par {automate.modeChangedBy.nom} le {fmtDateHeure(automate.modeChangedAt)}</p>
            )}
          </div>
        </div>
        )}
      </div>
      <ModeFooter current={automate.mode} descriptions={automate.modes} onChange={onChangeMode} isChanging={isChangingMode} disabled={!canPilot} />
    </div>
  )
}
