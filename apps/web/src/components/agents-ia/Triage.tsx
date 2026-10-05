// Agents IA › Triage — the screen side of the agent that sorts contact@
// (apps/api/src/lib/agents/triage/). Its Exécutions tab lists the mails with
// their categories; a run opens on the mail itself (read live from Gmail) next
// to what the Triage decided, and « Corriger le tri » changes the categories.
//
// The one agent corrected from Agents IA (decision Vincent 2026-10-05): its
// work IS the triage. Correct by default — nobody confirms, a correction is
// an échec with a why, and it moves the Gmail labels and hands the mail to
// the agent of a new category (server side, PUT /runs/:id/categories).

import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleSlash,
  Clock,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  RotateCcw,
  Tags,
  User,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { apiFetch, API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'
import { callApi, fmtDateCourte, fmtDateHeure, KV, useBaseApi } from './commun'

export const TRIAGE_SLUG = 'triage'

// ── Types (mirror lib/agents/triage/) ────────────────────

interface Auteur { id: number; nom: string }
interface Categorie { cle: string; libelle: string; description: string; cible?: string; cibleNom: string | null }
type TypeOrganisation = 'interne' | 'client' | 'sous_traitant' | 'fournisseur' | 'transporteur' | 'prospect'
interface Organisation { type: TypeOrganisation; id: number; nom: string; par: 'adresse' | 'domaine' }
interface Transmission {
  categorie: string
  agent: string
  nom: string
  le: string
  statut: 'transmis' | 'deja_traite' | 'non_transmis' | 'erreur'
  raison: string | null
  runs: Array<{ id: string; statut: string; resume: string }>
  tentatives: number
}
interface CorrectionTriage { avant: string[]; apres: string[]; commentaire: string; par: Auteur; le: string }
interface ResultatTriage {
  expediteur: { adresse: string; organisation: Organisation | null }
  a: string
  cc: string
  piecesJointes: string[]
  extrait: string
  raison: string
  categoriesAgent: string[]
  categories: string[]
  sousCategories: Record<string, string | null>
  transmissions: Transmission[]
  libelles: string[]
  erreurLibelles: string | null
  corrections: CorrectionTriage[]
}
interface Evaluation { note: 'reussite' | 'echec'; commentaire: string; par: Auteur; le: string }
interface RunTriage {
  id: string
  createdAt: string
  source: string
  mode: 'off' | 'essai' | 'actif'
  statut: string
  resume: string
  coutUsd: number
  version: number
  model: string
  erreur?: string
  message?: { id: string; threadId: string; de: string; sujet: string; date: string } | null
  evaluation?: Evaluation | null
  resultat: Partial<ResultatTriage>
}
/** A run as the list returns it (routes/agents-ia.ts allege + AgentDef.ligne). */
interface LigneTriage {
  id: string
  createdAt: string
  source: string
  mode: 'off' | 'essai' | 'actif'
  statut: string
  resume: string
  erreur?: string
  message?: { de: string; sujet: string; date: string } | null
  evaluation?: Evaluation | null
  categories?: string[]
  sousCategories?: Record<string, string | null>
  expediteur?: { adresse: string; organisation: Organisation | null } | null
  corrige?: boolean
  transmissions?: Array<{ agent: string; nom: string; statut: Transmission['statut']; runs: string[] }>
  extrait?: string
}
interface MailFil {
  messageId: string
  messages: Array<{
    id: string; de: string; a: string; cc: string; sujet: string; date: string; envoye: boolean; texte: string
    piecesJointes: Array<{ n: number; nom: string; mimeType: string; taille: number }>
  }>
}

// ── Look ─────────────────────────────────────────────────

/** One hue per family of category, so a list of mails reads at a glance. */
const TEINTE: Record<string, string> = {
  bl_ennoblisseur: 'bg-sky-500/10 text-sky-700 border-sky-500/25',
  facture_sous_traitant: 'bg-sky-500/10 text-sky-700 border-sky-500/25',
  sous_traitant: 'bg-sky-500/10 text-sky-700 border-sky-500/25',
  commande_client: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
  demande_prix: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
  suivi_client: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
  qualite: 'bg-red-500/10 text-red-700 border-red-500/25',
  fournisseur: 'bg-teal-500/10 text-teal-700 border-teal-500/25',
  transport: 'bg-teal-500/10 text-teal-700 border-teal-500/25',
  facture_fournisseur: 'bg-violet-500/10 text-violet-700 border-violet-500/25',
  facturation_client: 'bg-violet-500/10 text-violet-700 border-violet-500/25',
  administratif: 'bg-stone-500/10 text-stone-700 border-stone-500/25',
}
const TEINTE_NEUTRE = 'bg-zinc-100 text-zinc-600 border-zinc-300'

function CategorieChip({ cle, libelle, sous, size = 'sm' }: { cle: string; libelle: string; sous?: string | null; size?: 'sm' | 'md' }) {
  return (
    <span className={cn('inline-flex items-center rounded border font-medium whitespace-nowrap max-w-full',
      size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs', TEINTE[cle] ?? TEINTE_NEUTRE)}>
      <span className="truncate">{libelle}{sous ? ` · ${sous}` : ''}</span>
    </span>
  )
}

const TRANSMISSION_META: Record<Transmission['statut'], { label: string; icon: ComponentType<{ className?: string }>; cls: string }> = {
  transmis: { label: 'Transmis', icon: CheckCircle2, cls: 'text-green-700' },
  deja_traite: { label: 'Déjà traité', icon: CheckCircle2, cls: 'text-zinc-500' },
  non_transmis: { label: 'Non transmis', icon: CircleSlash, cls: 'text-zinc-500' },
  erreur: { label: 'Erreur', icon: XCircle, cls: 'text-destructive' },
}

const ORG_LIBELLE: Record<TypeOrganisation, string> = {
  interne: 'Interne', client: 'Client', sous_traitant: 'Sous-traitant', fournisseur: 'Fournisseur', transporteur: 'Transporteur', prospect: 'Prospect',
}

const RUN_STATUT_LABEL: Record<string, string> = {
  ecrit: 'Enregistré', simule: 'Simulé', a_verifier: 'À vérifier', deja_importe: 'Déjà importé', ignore: 'Ignoré', erreur: 'Erreur',
}

function useCategories(slug: string) {
  const base = useBaseApi()
  return useQuery({
    queryKey: ['agent-ia-categories', slug],
    queryFn: () => apiFetch<Categorie[]>(`${base}/${slug}/categories`),
    staleTime: Infinity,
  })
}

// ── Exécutions ───────────────────────────────────────────

const FILTRES: Array<{ key: string; label: string; query: string }> = [
  { key: 'tout', label: 'Tous', query: '' },
  { key: 'corriges', label: 'Corrigés', query: 'note=echec' },
  { key: 'erreurs', label: 'Erreurs', query: 'statut=erreur' },
]

export function TriageExecutionsTab({ slug, onOpenRun }: { slug: string; onOpenRun: (id: string) => void }) {
  const base = useBaseApi()
  const [filtre, setFiltre] = useState('tout')
  const [categorie, setCategorie] = useState(0)
  const { data: categories } = useCategories(slug)
  const cat = categorie > 0 ? categories?.[categorie - 1]?.cle ?? '' : ''
  const query = [FILTRES.find((f) => f.key === filtre)?.query, cat ? `categorie=${cat}` : ''].filter(Boolean).join('&')
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ia-runs', slug, filtre, cat],
    queryFn: () => apiFetch<{ total: number; runs: LigneTriage[] }>(`${base}/${slug}/runs${query ? `?${query}` : ''}`),
    refetchInterval: 30_000,
  })
  const libelle = useMemo(() => new Map((categories ?? []).map((c) => [c.cle, c.libelle])), [categories])

  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {FILTRES.map((f) => (
          <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
            className={cn('px-3 py-1 text-xs rounded-md transition-colors',
              filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
            {f.label}
          </button>
        ))}
        <PopoverSelect
          size="sm"
          widthClass="w-[200px]"
          value={categorie}
          onChange={setCategorie}
          emptyLabel="Toutes les catégories"
          options={(categories ?? []).map((c, i) => ({ id: i + 1, primary: c.libelle }))}
        />
        {data && <span className="ml-auto text-xs text-muted-foreground">{data.total} mail{data.total !== 1 ? 's' : ''}</span>}
      </div>
      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
      : isError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">Chargement impossible</p></div>
      : !data || data.runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Inbox className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">Aucun mail trié</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '13%' }} /><col style={{ width: '20%' }} /><col style={{ width: '29%' }} />
              <col style={{ width: '24%' }} /><col style={{ width: '14%' }} />
            </colgroup>
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 text-left font-semibold">Reçu</th>
                <th className="px-3 py-2.5 text-left font-semibold">De</th>
                <th className="px-3 py-2.5 text-left font-semibold">Objet</th>
                <th className="px-3 py-2.5 text-left font-semibold">Catégories</th>
                <th className="px-3 py-2.5 text-left font-semibold">Transmis</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => {
                const org = r.expediteur?.organisation
                return (
                  <tr key={r.id} onClick={() => onOpenRun(r.id)} title={r.extrait || r.resume}
                    className="border-b border-border/40 last:border-b-0 cursor-pointer hover:bg-accent/5 transition-colors align-top">
                    <td className="px-3 py-1.5">
                      <div className="tabular-nums truncate">{fmtDateCourte(r.message?.date || r.createdAt)}</div>
                      {r.mode === 'essai' && <div className="text-[11px] text-muted-foreground">essai</div>}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="truncate font-medium">{org?.nom ?? r.expediteur?.adresse ?? r.message?.de ?? '—'}</div>
                      {org && <div className="text-[11px] text-muted-foreground truncate">{r.expediteur?.adresse}</div>}
                    </td>
                    <td className="px-3 py-1.5 truncate">{r.message?.sujet || <span className="italic text-muted-foreground">(sans objet)</span>}</td>
                    <td className="px-3 py-1.5">
                      {r.statut === 'erreur' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3.5 w-3.5" />Erreur</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1">
                          {(r.categories ?? []).map((c) => <CategorieChip key={c} cle={c} libelle={libelle.get(c) ?? c} sous={r.sousCategories?.[c]} />)}
                          {r.corrige && (
                            <span title={r.evaluation?.commentaire ? `Corrigé — ${r.evaluation.commentaire}` : 'Corrigé'} className="inline-flex">
                              <TricobotMascot className="h-4 w-4" />
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-col gap-0.5">
                        {(r.transmissions ?? []).map((t) => {
                          const m = TRANSMISSION_META[t.statut]
                          const Icon = m.icon
                          return (
                            <span key={t.agent} className={cn('inline-flex items-center gap-1 text-xs truncate', m.cls)} title={`${t.nom} — ${m.label}`}>
                              <Icon className="h-3 w-3 flex-shrink-0" /><span className="truncate">{t.nom}</span>
                            </span>
                          )
                        })}
                        {!(r.transmissions ?? []).length && <span className="text-muted-foreground">—</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── Run dialog ───────────────────────────────────────────

export function TriageRunDialog({ slug, runId, canPilot, onClose, onOuvrirRunAgent, onChanged }: {
  slug: string
  runId: string | null
  canPilot: boolean
  onClose: () => void
  /** Open a run of another agent (the one the mail was handed to). */
  onOuvrirRunAgent: (agent: string, runId: string) => void
  onChanged: () => void
}) {
  const base = useBaseApi()
  const queryClient = useQueryClient()
  const [corrigerOpen, setCorrigerOpen] = useState(false)
  const [dejaTraites, setDejaTraites] = useState<Transmission[]>([])
  const { data: categories } = useCategories(slug)
  const { data: run, isLoading } = useQuery({
    queryKey: ['agent-ia-run', slug, runId],
    queryFn: () => apiFetch<RunTriage>(`${base}/${slug}/runs/${runId}`),
    enabled: runId !== null,
  })
  const { data: mail, isLoading: mailLoading, error: mailError } = useQuery({
    queryKey: ['agent-ia-run-mail', slug, runId],
    queryFn: () => apiFetch<MailFil>(`${base}/${slug}/runs/${runId}/mail`),
    enabled: runId !== null && !!run?.message?.threadId,
    staleTime: 5 * 60_000,
  })
  useEffect(() => { setCorrigerOpen(false); setDejaTraites([]) }, [runId])

  const corrigerMut = useMutation({
    mutationFn: (v: { categories: string[]; commentaire: string }) =>
      callApi<{ run: RunTriage; dejaTraites: Transmission[] }>(`${base}/${slug}/runs/${runId}/categories`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      queryClient.setQueryData(['agent-ia-run', slug, runId], r.run)
      setDejaTraites(r.dejaTraites)
      setCorrigerOpen(false)
      onChanged()
    },
  })

  const libelle = useMemo(() => new Map((categories ?? []).map((c) => [c.cle, c.libelle])), [categories])
  const res = run?.resultat ?? {}
  const org = res.expediteur?.organisation ?? null
  const triable = run?.statut === 'trie'

  return (
    <>
    <Dialog open={runId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-6xl w-[94vw] h-[88vh] p-0 border-0 bg-primary overflow-hidden flex flex-col">
        {/* Header band (§18.D / §43) */}
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <Tags className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
              {run?.message?.sujet || '(sans objet)'}
            </h2>
            <p className="text-xs text-white/70 truncate">
              {run?.message?.de ?? ''}{run?.message?.date ? ` · ${fmtDateHeure(run.message.date)}` : ''}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {isLoading || !run ? (
          <div className="flex-1 flex items-center justify-center bg-zinc-100"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col md:flex-row bg-zinc-100">
            {/* Left: what the Triage decided */}
            <div className="md:w-[380px] flex-shrink-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent border-b md:border-b-0 md:border-r border-border/60">
              {run.statut === 'erreur' ? (
                <div className="rounded-lg border-l-4 border-l-destructive/60 border border-border/60 bg-card p-3 shadow-sm text-sm">
                  <div className="flex items-center gap-2 font-semibold text-destructive"><XCircle className="h-4 w-4" />Tri impossible</div>
                  <p className="mt-1 text-muted-foreground break-words">{run.erreur}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Retenté aux relevés suivants, 3 fois au plus.</p>
                </div>
              ) : (
                <>
                  <div className={cn('rounded-lg border border-border/60 bg-card p-3 shadow-sm', res.corrections?.length ? 'border-l-4 border-l-accent/70' : '')}>
                    <div className="flex items-center gap-2 mb-2">
                      <Tags className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Catégories</h3>
                      {run.mode === 'essai' && <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">Essai</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(res.categories ?? []).map((c) => <CategorieChip key={c} cle={c} libelle={libelle.get(c) ?? c} sous={res.sousCategories?.[c]} size="md" />)}
                    </div>
                    {res.raison && <p className="mt-2 text-sm text-muted-foreground">{res.raison}</p>}
                    {!!res.corrections?.length && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Tricobot avait choisi : {(res.categoriesAgent ?? []).map((c) => libelle.get(c) ?? c).join(' + ')}
                      </p>
                    )}
                    {triable && canPilot && (
                      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => setCorrigerOpen(true)}>
                        <TricobotMascot className="h-4 w-4 mr-1.5" />Corriger le tri
                      </Button>
                    )}
                  </div>

                  {dejaTraites.length > 0 && (
                    <div className="rounded-lg border-l-4 border-l-amber-400/60 border border-border/60 bg-card p-3 shadow-sm text-sm">
                      <div className="flex items-center gap-2 font-semibold text-amber-700"><AlertTriangle className="h-4 w-4" />Déjà traité ailleurs</div>
                      <p className="mt-1 text-muted-foreground">Ce mail avait déjà été transmis — rien n’a été défait. À reprendre dans l’agent :</p>
                      {dejaTraites.map((t) => t.runs.map((r) => (
                        <button key={r.id} type="button" onClick={() => onOuvrirRunAgent(t.agent, r.id)}
                          className="mt-1 flex w-full items-center gap-1.5 text-left text-xs text-accent-blue hover:underline">
                          <ArrowRight className="h-3 w-3 flex-shrink-0" /><span className="truncate">{t.nom} · {r.resume}</span>
                        </button>
                      )))}
                    </div>
                  )}

                  <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-1">
                    <div className="flex items-center gap-2 mb-1"><User className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Expéditeur</h3></div>
                    <KV label="Adresse" value={res.expediteur?.adresse ?? '—'} />
                    <KV label="Connu comme" value={org ? `${ORG_LIBELLE[org.type]} · ${org.nom}` : 'Inconnu dans ETM'} />
                    {org?.par === 'domaine' && <p className="text-[11px] text-muted-foreground">Reconnu par le domaine de son adresse.</p>}
                  </div>

                  {(res.transmissions ?? []).length > 0 && (
                    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                      <div className="flex items-center gap-2 mb-2"><ArrowRight className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Transmissions</h3></div>
                      <div className="space-y-2">
                        {(res.transmissions ?? []).map((t, i) => {
                          const m = TRANSMISSION_META[t.statut]
                          const Icon = m.icon
                          return (
                            <div key={`${t.agent}-${i}`} className="text-sm">
                              <div className={cn('flex items-center gap-1.5 font-medium', m.cls)}>
                                <Icon className="h-3.5 w-3.5" />{t.nom}
                                <span className="ml-auto text-[11px] font-normal text-muted-foreground">{m.label}{t.tentatives > 1 ? ` · essai ${t.tentatives}` : ''}</span>
                              </div>
                              {t.raison && <p className="text-xs text-muted-foreground mt-0.5">{t.raison}</p>}
                              {t.runs.map((r) => (
                                <button key={r.id} type="button" onClick={() => onOuvrirRunAgent(t.agent, r.id)}
                                  className="mt-0.5 flex w-full items-center gap-1.5 text-left text-xs text-accent-blue hover:underline">
                                  <ArrowRight className="h-3 w-3 flex-shrink-0" />
                                  <span className="truncate">{RUN_STATUT_LABEL[r.statut] ?? r.statut} · {r.resume}</span>
                                </button>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {(res.libelles?.length || res.erreurLibelles) && (
                    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                      <div className="flex items-center gap-2 mb-2"><Mail className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Libellés Gmail</h3></div>
                      <div className="flex flex-wrap gap-1">
                        {(res.libelles ?? []).map((l) => <span key={l} className="rounded border border-border/60 bg-zinc-100 px-1.5 py-0.5 text-[11px]">{l}</span>)}
                      </div>
                      {res.erreurLibelles && <p className="mt-1 text-xs text-destructive">{res.erreurLibelles}</p>}
                    </div>
                  )}

                  {!!res.corrections?.length && (
                    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                      <div className="flex items-center gap-2 mb-2"><RotateCcw className="h-4 w-4 text-accent" /><h3 className="text-sm font-semibold">Corrections</h3></div>
                      <div className="space-y-2">
                        {[...(res.corrections ?? [])].reverse().map((c, i) => (
                          <div key={i} className="text-xs">
                            <div className="text-muted-foreground">{fmtDateHeure(c.le)} · {c.par.nom}</div>
                            <div className="mt-0.5">
                              {c.avant.map((x) => libelle.get(x) ?? x).join(' + ')} → <span className="font-medium">{c.apres.map((x) => libelle.get(x) ?? x).join(' + ')}</span>
                            </div>
                            {c.commentaire
                              ? <p className="mt-0.5 italic text-muted-foreground">« {c.commentaire} »</p>
                              : <p className="mt-0.5 italic text-muted-foreground">Retour au choix de Tricobot — la correction est retirée.</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <p className="text-[11px] text-muted-foreground px-1">
                Version {run.version} · {run.model}{run.coutUsd ? ` · ${(run.coutUsd * 0.86).toFixed(4).replace('.', ',')} €` : ''}
              </p>
            </div>

            {/* Right: the mail and its thread, read live from Gmail */}
            <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
              {mailLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
              : mailError ? <div className="flex flex-col items-center justify-center py-12 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">{(mailError as Error).message}</p></div>
              : !mail ? <div className="flex flex-col items-center justify-center py-12 text-muted-foreground"><Mail className="h-12 w-12 mb-3 opacity-40" /><p className="text-sm">Mail indisponible</p></div>
              : mail.messages.map((m) => {
                const cible = m.id === mail.messageId
                return (
                  <div key={m.id} className={cn('rounded-lg border bg-card shadow-sm',
                    cible ? 'border-accent ring-1 ring-accent' : 'border-border/60 opacity-80')}>
                    <div className="flex items-start gap-2 border-b border-border/60 bg-zinc-200/50 px-3 py-2 rounded-t-lg">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{m.envoye ? 'ETS Malterre (envoyé)' : m.de}</div>
                        <div className="text-[11px] text-muted-foreground truncate">À : {m.a}{m.cc ? ` · Cc : ${m.cc}` : ''}</div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <div className="text-[11px] text-muted-foreground tabular-nums">{fmtDateHeure(m.date)}</div>
                        {cible && <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">Mail trié</div>}
                      </div>
                    </div>
                    <div className="px-3 py-2">
                      {!cible && <div className="text-xs font-medium mb-1">{m.sujet}</div>}
                      <p className={cn('text-sm whitespace-pre-wrap break-words', !cible && 'line-clamp-6 text-muted-foreground')}>{m.texte || <span className="italic text-muted-foreground">(corps vide)</span>}</p>
                      {m.piecesJointes.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {m.piecesJointes.map((p) => (
                            <a key={p.n} href={`${API_URL}${base}/${slug}/runs/${runId}/mail/${m.id}/pieces/${p.n}`} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2 py-1 text-xs hover:border-accent/40 hover:bg-accent/5">
                              <Paperclip className="h-3 w-3 text-muted-foreground" />
                              <span className="truncate max-w-[220px]">{p.nom}</span>
                              <span className="text-muted-foreground">{p.taille > 0 ? `${Math.max(1, Math.round(p.taille / 1024))} Ko` : ''}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <div className="flex-shrink-0 h-1 bg-zinc-200 rounded-b-lg" />
      </DialogContent>
    </Dialog>

      <CorrectionDialog
        open={corrigerOpen}
        categories={categories ?? []}
        actuelles={res.categories ?? []}
        agent={res.categoriesAgent ?? []}
        actif={run?.mode === 'actif'}
        isPending={corrigerMut.isPending}
        error={corrigerMut.error as Error | null}
        onClose={() => { setCorrigerOpen(false); corrigerMut.reset() }}
        onConfirm={(categories, commentaire) => corrigerMut.mutate({ categories, commentaire })}
      />
    </>
  )
}

// ── Correction ───────────────────────────────────────────

function CorrectionDialog({ open, categories, actuelles, agent, actif, isPending, error, onClose, onConfirm }: {
  open: boolean
  categories: Categorie[]
  actuelles: string[]
  /** What the model chose: going back to it withdraws the correction (no why needed). */
  agent: string[]
  actif: boolean
  isPending: boolean
  error: Error | null
  onClose: () => void
  onConfirm: (categories: string[], commentaire: string) => void
}) {
  const [choix, setChoix] = useState<string[]>([])
  const [commentaire, setCommentaire] = useState('')
  useEffect(() => { if (open) { setChoix(actuelles); setCommentaire('') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const memes = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
  const inchange = memes(choix, actuelles)
  const retour = memes(choix, agent)
  const nouvellesCibles = categories.filter((c) => c.cible && choix.includes(c.cle) && !actuelles.includes(c.cle))
  const pret = choix.length > 0 && !inchange && (retour || commentaire.trim().length > 0)
  const basculer = (cle: string) => setChoix((p) => (p.includes(cle) ? p.filter((x) => x !== cle) : [...p, cle]))

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TricobotMascot className="h-5 w-5" />Corriger le tri</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">Choisissez la ou les bonnes catégories (la première cochée est la principale).</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {categories.map((c) => {
              const on = choix.includes(c.cle)
              return (
                <button key={c.cle} type="button" onClick={() => basculer(c.cle)} title={c.description}
                  className={cn('flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                    on ? 'border-accent bg-accent/10 ring-1 ring-accent' : 'border-border/60 bg-white hover:border-accent/40')}>
                  <span className={cn('mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded-sm border flex items-center justify-center',
                    on ? 'bg-accent border-accent text-accent-foreground' : 'border-input')}>
                    {on && <CheckCircle2 className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{c.libelle}{agent.includes(c.cle) && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(Tricobot)</span>}</span>
                    {c.cibleNom && <span className="block text-[11px] text-muted-foreground">→ {c.cibleNom}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          {retour && !inchange ? (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5"><RotateCcw className="h-4 w-4" />Retour au choix de Tricobot : la correction est retirée.</p>
          ) : (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Pourquoi ? (Tricobot s’en sert pour s’améliorer)</label>
              <textarea rows={3} value={commentaire} onChange={(e) => setCommentaire(e.target.value)}
                placeholder="Ex. : c’est une demande de certificat Oeko-Tex, donc Qualité."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
            </div>
          )}
          {actif && nouvellesCibles.length > 0 && (
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Clock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              Le mail sera transmis à {nouvellesCibles.map((c) => c.cibleNom).join(' et ')} (s’il est en service avec l’option « Mails transmis par le Triage »).
            </p>
          )}
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error.message}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => onConfirm(choix, commentaire)} disabled={!pret || isPending}>
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
