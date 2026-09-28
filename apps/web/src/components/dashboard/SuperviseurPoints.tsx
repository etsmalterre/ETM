// ── Superviseur points in the Notifications widget ────────────
// The agent Superviseur's morning points are handled HERE, one by one, not in
// its reports (decision 2026-09-28 — Agents IA is the admin side). A point
// ends one of two ways, and only what can be improved is written:
//   - « Traité »        → réussite; « Le point pouvait être mieux » opens a
//                         required comment for Tricobot (→ partielle);
//   - « Fausse alerte » → échec, comment required.
// API: PUT /agents-ia/superviseur/points/traitement, GET …/points/historique
// (apps/api/src/lib/agents/superviseur/points.ts, historique.ts).

import { useMemo, useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, AlertTriangle, ArrowRight, CheckCheck, CircleDashed, Clock, ExternalLink,
  History, Info, Loader2, RotateCcw, X, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

type Gravite = 'urgent' | 'attention' | 'info'
type Issue = 'traite' | 'fausse_alerte'
type Note = 'reussite' | 'partielle' | 'echec'

export interface PointSuperviseur {
  runId: string
  cle: string
  gravite: Gravite
  /** French label. */
  domaine: string
  nouveau: boolean
  depuis: string
  lien: string | null
}

interface Traitement { issue: Issue; note: Note; commentaire: string; par: { id: number; nom: string }; le: string }
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
  traitement: Traitement | null
}

const GRAVITE_META: Record<Gravite, { border: string; iconBg: string; iconCls: string; icon: ComponentType<{ className?: string }>; label: string }> = {
  urgent: { border: 'border-l-destructive/60', iconBg: 'bg-destructive/10', iconCls: 'text-destructive/70', icon: AlertTriangle, label: 'Urgent' },
  attention: { border: 'border-l-amber-400/60', iconBg: 'bg-amber-400/10', iconCls: 'text-amber-600', icon: AlertCircle, label: 'Attention' },
  info: { border: 'border-l-border', iconBg: 'bg-muted', iconCls: 'text-muted-foreground', icon: Info, label: 'Info' },
}

const DOMAINE_LIBELLE: Record<string, string> = {
  mails: 'Mails clients', commandes_client: 'Commandes clients', devis: 'Devis', sous_traitants: 'Sous-traitants',
  fils: 'Fils', stock: 'Stock', references: 'Références', etudes_coloris: 'Études coloris', qualite: 'Qualité',
  integrite: 'Intégrité des données',
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR')
const joursDepuis = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))

/** The agent writes « … À faire : … »: the action gets its own line. */
function decouperMessage(m: string): { contexte: string; action: string | null } {
  const i = m.search(/À faire\s*:/)
  if (i < 0) return { contexte: m.trim(), action: null }
  return { contexte: m.slice(0, i).trim(), action: m.slice(i).replace(/^À faire\s*:\s*/, '').trim() || null }
}

const messageErreur = (e: unknown) =>
  ((e as { body?: { error?: string } })?.body?.error) ?? 'L’enregistrement a échoué.'

// ── One point card ───────────────────────────────────────
// §7 center-panel item card, left edge by gravity. The two actions are always
// visible: handling the point is the whole reason it is on the dashboard.

export function SuperviseurPointCard({ titre, description, point, onTraiter }: {
  titre: string
  description: string
  point: PointSuperviseur
  onTraiter: (issue: Issue) => void
}) {
  const g = GRAVITE_META[point.gravite]
  const Icon = g.icon
  const j = joursDepuis(point.depuis)
  const { contexte, action } = decouperMessage(description)
  return (
    <div className={cn('rounded-lg border border-border/60 border-l-4 bg-zinc-100/80 p-3', g.border)}>
      <div className="flex items-start gap-2">
        <div className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md', g.iconBg)}>
          <Icon className={cn('h-3.5 w-3.5', g.iconCls)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug line-clamp-2" title={titre}>{titre}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{point.domaine}</span>
            {point.nouveau
              ? <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-800">Nouveau</span>
              : <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />depuis {j === 0 ? 'aujourd’hui' : `${j} j`}</span>}
          </div>
        </div>
        {point.lien && (
          <Link to={point.lien} title="Ouvrir dans ETM"
            className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent">
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className="mt-2 ml-9 space-y-1.5">
        {contexte && <p className="text-xs leading-relaxed text-muted-foreground line-clamp-3" title={contexte}>{contexte}</p>}
        {action && (
          <div className="flex items-start gap-1.5 rounded-md border border-accent/25 bg-accent/[0.07] px-2 py-1">
            <ArrowRight className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-700" />
            <p className="text-xs leading-snug"><span className="font-semibold text-amber-800">À faire : </span>{action}</p>
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <button type="button" onClick={() => onTraiter('fausse_alerte')}
            title="Rien à faire : c’est faux, ou c’est normal"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-destructive/30 bg-white px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10">
            <XCircle className="h-3.5 w-3.5" />Fausse alerte
          </button>
          <button type="button" onClick={() => onTraiter('traite')}
            title="Le point était juste et il est réglé"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-green-600/30 bg-white px-2 text-xs font-medium text-green-700 transition-colors hover:bg-green-500/10">
            <CheckCheck className="h-3.5 w-3.5" />Traité
          </button>
        </div>
      </div>
    </div>
  )
}

// ── « Traité » / « Fausse alerte » confirmation ──────────
// §18.A dialog. « Traité » asks nothing by default; the §35 switch « Le point
// pouvait être mieux » opens the comment for Tricobot, then required.

export function TraitementDialog({ cible, onClose }: {
  cible: { titre: string; point: PointSuperviseur; issue: Issue } | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [aAmeliorer, setAAmeliorer] = useState(false)
  const [commentaire, setCommentaire] = useState('')
  const [erreur, setErreur] = useState('')

  const mut = useMutation({
    mutationFn: (body: { runId: string; cle: string; issue: Issue; aAmeliorer: boolean; commentaire: string }) =>
      apiFetch('/agents-ia/superviseur/points/traitement', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['superviseur-historique'] })
      fermer()
    },
    onError: (e) => setErreur(messageErreur(e)),
  })

  function fermer() {
    setAAmeliorer(false)
    setCommentaire('')
    setErreur('')
    onClose()
  }

  const fausse = cible?.issue === 'fausse_alerte'
  const commentaireRequis = fausse || aAmeliorer
  const pret = !commentaireRequis || commentaire.trim().length > 0

  return (
    <Dialog open={cible !== null} onOpenChange={(v) => { if (!v) fermer() }}>
      <DialogContent className="max-w-md" onClose={fermer}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {fausse
              ? <><XCircle className="h-5 w-5 text-destructive" />Signaler une fausse alerte ?</>
              : <><CheckCheck className="h-5 w-5 text-green-600" />Marquer ce point comme traité ?</>}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium leading-snug">{cible?.titre}</p>

          {!fausse && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white px-3 py-2.5 shadow-sm">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">Le point pouvait être mieux</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Mauvaise cause, mauvais client, mal formulé, déjà connu…</p>
              </div>
              <button type="button" role="switch" aria-checked={aAmeliorer} aria-label="Le point pouvait être mieux"
                onClick={() => { setAAmeliorer((v) => !v); setErreur('') }}
                className={cn(
                  'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  aAmeliorer ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                )}>
                <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
                  aAmeliorer ? 'translate-x-[18px]' : 'translate-x-0.5')} />
              </button>
            </div>
          )}

          {commentaireRequis && (
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <TricobotMascot className="h-5 w-5" />
                {fausse ? 'Pourquoi est-ce une fausse alerte ?' : 'Qu’est-ce qui pouvait être mieux ?'}
              </label>
              <textarea autoFocus rows={3} value={commentaire} onChange={(e) => { setCommentaire(e.target.value); setErreur('') }}
                placeholder="Un mot pour Tricobot : c’est ce qui sert à l’améliorer."
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          )}

          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={fermer} disabled={mut.isPending}>Annuler</Button>
          <Button
            disabled={!pret || mut.isPending || !cible}
            onClick={() => cible && mut.mutate({
              runId: cible.point.runId, cle: cible.point.cle, issue: cible.issue,
              aAmeliorer: !fausse && aAmeliorer, commentaire: commentaireRequis ? commentaire.trim() : '',
            })}
          >
            {mut.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : fausse ? <XCircle className="mr-1.5 h-4 w-4" /> : <CheckCheck className="mr-1.5 h-4 w-4" />}
            {fausse ? 'Fausse alerte' : 'Traité'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── History ──────────────────────────────────────────────
// §18.D banded dialog: every point the agent raised, open or closed, and how
// it was handled. A handled point still open can be put back in the queue.

const FILTRES = [
  { key: 'tous', label: 'Tous' },
  { key: 'a_traiter', label: 'À traiter' },
  { key: 'traites', label: 'Traités' },
  { key: 'fausses', label: 'Fausses alertes' },
] as const
type Filtre = (typeof FILTRES)[number]['key']

const ISSUE_META: Record<Note, { label: string; cls: string; icon: ComponentType<{ className?: string }> }> = {
  reussite: { label: 'Traité', cls: 'border-green-500/30 bg-green-500/10 text-green-700', icon: CheckCheck },
  partielle: { label: 'Traité · pouvait être mieux', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-800', icon: CircleDashed },
  echec: { label: 'Fausse alerte', cls: 'border-destructive/30 bg-destructive/10 text-destructive', icon: XCircle },
}

export function HistoriqueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [erreur, setErreur] = useState('')

  const { data, isLoading, isError } = useQuery<{ points: PointHistorique[] }>({
    queryKey: ['superviseur-historique'],
    queryFn: () => apiFetch('/agents-ia/superviseur/points/historique'),
    enabled: open,
  })

  const retablir = useMutation({
    mutationFn: (cle: string) =>
      apiFetch('/agents-ia/superviseur/points/traitement', { method: 'PUT', body: JSON.stringify({ cle, issue: null }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['superviseur-historique'] })
    },
    onError: (e) => setErreur(messageErreur(e)),
  })

  const points = useMemo(() => {
    const all = data?.points ?? []
    switch (filtre) {
      case 'a_traiter': return all.filter((p) => !p.traitement && !p.fermeLe)
      case 'traites': return all.filter((p) => p.traitement?.issue === 'traite')
      case 'fausses': return all.filter((p) => p.traitement?.issue === 'fausse_alerte')
      default: return all
    }
  }, [data, filtre])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <History className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Historique des points</h2>
            <p className="text-xs text-white/70 truncate">Agent Superviseur — chaque point signalé, et ce qui en a été fait</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-shrink-0 flex flex-wrap gap-1 border-b border-border/60 bg-zinc-200 px-4 py-2">
          {FILTRES.map((f) => (
            <button key={f.key} type="button" onClick={() => setFiltre(f.key)}
              className={cn('px-2 py-1 text-xs rounded-md transition-colors',
                filtre === f.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-b-lg bg-zinc-100 p-4 space-y-2 scrollbar-transparent">
          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
          {isLoading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>}
          {isError && <p className="py-8 text-center text-sm text-destructive">Impossible de charger l’historique.</p>}
          {!isLoading && !isError && points.length === 0 && (
            <p className="py-10 text-center text-sm italic text-muted-foreground">Aucun point.</p>
          )}
          {points.map((p) => {
            const g = GRAVITE_META[p.gravite]
            const t = p.traitement
            const m = t ? ISSUE_META[t.note] : null
            const MIcon = m?.icon
            return (
              <div key={p.id} className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug">{p.titre}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {DOMAINE_LIBELLE[p.domaine] ?? p.domaine} · <span className={g.iconCls}>{g.label}</span> · signalé le {fmtDate(p.depuis)}
                      {p.fermeLe ? ` · fermé le ${fmtDate(p.fermeLe)}` : ' · toujours détecté'}
                    </p>
                  </div>
                  {m && MIcon
                    ? <span className={cn('inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', m.cls)}><MIcon className="h-3 w-3" />{m.label}</span>
                    : !p.fermeLe && <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"><Clock className="h-3 w-3" />À traiter</span>}
                </div>
                {t && (
                  <div className="mt-1.5 flex items-start gap-1.5 text-xs">
                    <span className="min-w-0 flex-1">
                      {t.commentaire && <span className="italic">« {t.commentaire} » </span>}
                      <span className="text-muted-foreground">— {t.par.nom}, {fmtDate(t.le)}</span>
                    </span>
                    {!p.fermeLe && (
                      <button type="button" disabled={retablir.isPending}
                        onClick={() => { setErreur(''); retablir.mutate(p.cle) }}
                        title="Remettre ce point dans les notifications"
                        className="inline-flex flex-shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-accent disabled:opacity-50">
                        {retablir.isPending && retablir.variables === p.cle ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                        Rétablir
                      </button>
                    )}
                  </div>
                )}
                {p.fermeLe && p.raisonFermeture && (
                  <p className="mt-1 text-[11px] text-green-700">Fermé par l’agent : {p.raisonFermeture}</p>
                )}
                {p.lien && (
                  <Link to={p.lien} onClick={onClose} className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent-blue hover:underline">
                    <ExternalLink className="h-3 w-3" />Ouvrir dans ETM
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
