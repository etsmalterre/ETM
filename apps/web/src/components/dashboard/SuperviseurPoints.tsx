// ── Superviseur points in the Notifications widget ────────────
// The agent Superviseur's morning points are handled HERE, one by one, not in
// its reports (decision 2026-09-28: Agents IA is the admin side). LIVA #1272
// (2026-10-08) keeps two gestures apart, each on the card:
//   - « Traité » settles the point → réussite, with an optional word on how
//     it was handled;
//   - « Former Tricobot » teaches him, at any time: also from the history,
//     also once the agent closed the point: « n'aurait pas dû remonter »
//     (échec, the point leaves the list) or « tu pouvais aller chercher plus
//     loin » (a lesson, no score, the point stays).
// Doing nothing is fine too: the agent closes the point when it is settled.
// API: PUT /agents-ia/superviseur/points/traitement, POST …/points/tricobot,
// GET …/points/historique (apps/api/src/lib/agents/superviseur/points.ts).

import { useMemo, useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, AlertTriangle, ArrowRight, CheckCheck, Clock, ExternalLink,
  History, Info, Lightbulb, Loader2, RotateCcw, Search, X, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { TricobotBouton } from '@/components/tricobot/TricobotRetour'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

type Gravite = 'urgent' | 'attention' | 'info'
type Issue = 'traite' | 'fausse_alerte'
type Note = 'reussite' | 'echec'

export interface PointSuperviseur {
  runId: string
  cle: string
  gravite: Gravite
  /** French label. */
  domaine: string
  nouveau: boolean
  depuis: string
  lien: string | null
  /** Lessons already given to Tricobot on this point. */
  lecons: number
}

interface Lecon { commentaire: string; par: { id: number; nom: string }; le: string }
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
  lecons: Lecon[]
}

/** What « Former Tricobot » is about: one occurrence of a point. */
export interface CiblePoint { cle: string; depuis: string; titre: string; ouvert: boolean }

const GRAVITE_META: Record<Gravite, { border: string; iconBg: string; iconCls: string; pill: string; icon: ComponentType<{ className?: string }>; label: string }> = {
  urgent: { border: 'border-l-destructive/60', iconBg: 'bg-destructive/10', iconCls: 'text-destructive/70', pill: 'border-destructive/30 bg-destructive/10 text-destructive', icon: AlertTriangle, label: 'Urgent' },
  attention: { border: 'border-l-amber-400/60', iconBg: 'bg-amber-400/10', iconCls: 'text-amber-600', pill: 'border-amber-500/30 bg-amber-500/10 text-amber-800', icon: AlertCircle, label: 'Attention' },
  info: { border: 'border-l-border', iconBg: 'bg-muted', iconCls: 'text-muted-foreground', pill: 'border-border bg-muted text-muted-foreground', icon: Info, label: 'Info' },
}

const DOMAINE_LIBELLE: Record<string, string> = {
  mails: 'Mails clients', commandes_client: 'Commandes clients', devis: 'Devis', sous_traitants: 'Sous-traitants',
  fils: 'Fils', stock: 'Stock', references: 'Références', etudes_coloris: 'Études coloris', qualite: 'Qualité',
  integrite: 'Intégrité des données',
}

/** Points saved before 2026-10-08 carry em dashes in their titles and
 *  messages (the agent's old templates); never show one (Vincent's rule). */
export const sansTiretTitre = (t: string) => t.replace(/\s*—\s*/g, ' · ')
export const sansTiretTexte = (t: string) => t.replace(/\s*—\s*/g, ' ; ')

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
// White card with a gravity left edge, like the widget's other cards (the §8.1
// white-on-panel card: grey cards on the white widget body read as dull). Both gestures are always
// visible: teaching Tricobot never settles the point, settling never asks
// for a score.

export function SuperviseurPointCard({ titre, description, point, onTraiter, onFormer }: {
  titre: string
  description: string
  point: PointSuperviseur
  onTraiter: () => void
  onFormer: () => void
}) {
  const g = GRAVITE_META[point.gravite]
  const Icon = g.icon
  const j = joursDepuis(point.depuis)
  const { contexte, action } = decouperMessage(sansTiretTexte(description))
  titre = sansTiretTitre(titre)
  return (
    <div className={cn('rounded-lg border border-border/60 border-l-4 bg-card p-3 shadow-sm', g.border)}>
      <div className="flex items-start gap-2">
        <div className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md', g.iconBg)}>
          <Icon className={cn('h-3.5 w-3.5', g.iconCls)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug line-clamp-2" title={titre}>{titre}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{point.domaine}</span>
            <span aria-hidden>·</span>
            {point.nouveau
              ? <span className="font-medium text-amber-700">Nouveau</span>
              : <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />depuis {j === 0 ? 'aujourd’hui' : `${j} j`}</span>}
          </div>
        </div>
        <span className={cn('flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold', g.pill)}>{g.label}</span>
      </div>
      <div className="mt-2 ml-9 space-y-1.5">
        {contexte && <p className="text-[13px] leading-relaxed text-foreground/80 line-clamp-4" title={contexte}>{contexte}</p>}
        {action && (
          <div className="flex items-start gap-1.5 rounded-md border border-accent/25 bg-accent/[0.07] px-2 py-1">
            <ArrowRight className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-700" />
            <p className="text-xs leading-snug"><span className="font-semibold text-amber-800">À faire : </span>{action}</p>
          </div>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2 border-t border-border/50 pt-2">
        {point.lien && (
          <Link to={point.lien} className="inline-flex items-center gap-1 text-xs text-accent-blue hover:underline">
            <ExternalLink className="h-3 w-3" />Ouvrir dans ETM
          </Link>
        )}
        {point.lecons > 0 && (
          <span className="text-[11px] text-muted-foreground" title="Remarques déjà données à Tricobot sur ce point">
            · {point.lecons} remarque{point.lecons > 1 ? 's' : ''} à Tricobot
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <TricobotBouton onClick={onFormer} label="Former Tricobot"
            title="Ce point n’aurait pas dû remonter, ou Tricobot pouvait aller chercher plus loin : dites-le-lui." />
          <button type="button" onClick={onTraiter}
            title="Le point était juste et il est réglé"
            className="inline-flex h-6 items-center gap-1 rounded-md bg-success px-2.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-success/90">
            <CheckCheck className="h-3.5 w-3.5" />Traité
          </button>
        </div>
      </div>
    </div>
  )
}

// ── « Traité » ───────────────────────────────────────────
// §18.A dialog. Settles the point; the word on how it was handled is
// optional (Isabelle, #1272: « traité ne me permet pas de mettre des données »).

export function TraiteDialog({ cible, onClose }: {
  cible: { titre: string; point: PointSuperviseur } | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [commentaire, setCommentaire] = useState('')
  const [erreur, setErreur] = useState('')

  const mut = useMutation({
    mutationFn: (body: { runId: string; cle: string; issue: 'traite'; commentaire: string }) =>
      apiFetch('/agents-ia/superviseur/points/traitement', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['superviseur-historique'] })
      fermer()
    },
    onError: (e) => setErreur(messageErreur(e)),
  })

  function fermer() {
    setCommentaire('')
    setErreur('')
    onClose()
  }

  return (
    <Dialog open={cible !== null} onOpenChange={(v) => { if (!v) fermer() }}>
      <DialogContent className="max-w-md" onClose={fermer}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCheck className="h-5 w-5 text-green-600" />Marquer ce point comme traité
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium leading-snug">{cible ? sansTiretTitre(cible.titre) : ''}</p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Comment ? <span className="font-normal">(facultatif)</span></label>
            <textarea autoFocus rows={3} value={commentaire} onChange={(e) => { setCommentaire(e.target.value); setErreur('') }}
              placeholder="Client appelé, confirmation renvoyée, livraison décalée…"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={fermer} disabled={mut.isPending}>Annuler</Button>
          <Button
            disabled={mut.isPending || !cible}
            onClick={() => cible && mut.mutate({ runId: cible.point.runId, cle: cible.point.cle, issue: 'traite', commentaire: commentaire.trim() })}
          >
            {mut.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCheck className="mr-1.5 h-4 w-4" />}
            Traité
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── « Former Tricobot » ──────────────────────────────────
// §18.A dialog, Tricobot speaking for himself (TricobotRetourDialog's mascot
// + bubble). Two kinds of feedback, why always required. Never settles a
// point by itself, except a false alarm, which has nothing left to do.

type Formation = 'pas_a_remonter' | 'a_savoir'

// Isabelle's feedback falls in two cases (2026-10-08): the point was wrong,
// or it was right but Tricobot could have looked further (another table, the
// client's history, PE's mails). Both ask WHERE the information was: what
// turns a comment into a rule for the next version.
const FORMATIONS: Array<{
  key: Formation
  label: string
  aide: (ouvert: boolean) => string
  question: string
  exemple: string
  icon: ComponentType<{ className?: string }>
  /** Picked: red = Tricobot was wrong, amber = right but could do better. */
  actif: string
  iconActif: string
}> = [
  {
    key: 'pas_a_remonter',
    label: 'Ce point n’aurait pas dû remonter',
    aide: (ouvert) => ouvert ? 'Fausse alerte : il quitte la liste.' : 'Fausse alerte.',
    question: 'Pourquoi ? Où aurais-je pu le voir ?',
    exemple: 'C’est noté dans la commande : solde sur appel.',
    icon: XCircle,
    actif: 'border-destructive bg-destructive/10 ring-1 ring-destructive',
    iconActif: 'text-destructive',
  },
  {
    key: 'a_savoir',
    label: 'Le point était juste, mais tu pouvais aller chercher plus loin',
    aide: (ouvert) => ouvert ? 'Le point reste dans la liste.' : 'Une remarque pour la suite.',
    question: 'Où aurais-je dû regarder ?',
    exemple: 'L’historique du client, les mails de PE, le commentaire de la commande…',
    icon: Search,
    actif: 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500',
    iconActif: 'text-amber-600',
  },
]

export function FormerTricobotDialog({ cible, onClose }: { cible: CiblePoint | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<Formation | null>(null)
  const [commentaire, setCommentaire] = useState('')
  const [erreur, setErreur] = useState('')

  const mut = useMutation({
    mutationFn: (body: { cle: string; depuis: string; type: Formation; commentaire: string }) =>
      apiFetch('/agents-ia/superviseur/points/tricobot', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['superviseur-historique'] })
      fermer()
    },
    onError: (e) => setErreur(messageErreur(e)),
  })

  function fermer() {
    setType(null)
    setCommentaire('')
    setErreur('')
    onClose()
  }

  const pret = !!cible && type !== null && commentaire.trim().length > 0
  const choix = FORMATIONS.find((f) => f.key === type) ?? null

  return (
    <Dialog open={cible !== null} onOpenChange={(v) => { if (!v) fermer() }}>
      <DialogContent className="max-w-md" onClose={fermer}>
        <DialogHeader>
          <DialogTitle>Former Tricobot</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="flex items-end gap-3">
            <TricobotMascot className="h-20 w-20 -mb-1 flex-shrink-0" />
            <div className="min-w-0 flex-1 rounded-xl rounded-bl-none border border-accent/30 bg-accent/10 px-3 py-2.5">
              <p className="text-sm font-semibold leading-snug">{cible ? sansTiretTitre(cible.titre) : ''}</p>
              <p className="mt-0.5 text-sm text-foreground/80">Qu’est-ce que je dois retenir ?</p>
            </div>
          </div>

          <div className="space-y-1.5">
            {FORMATIONS.map((f) => {
              const actif = type === f.key
              const FIcon = f.icon
              return (
                <button key={f.key} type="button" onClick={() => { setType(f.key); setErreur('') }} aria-pressed={actif}
                  className={cn('w-full flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                    actif ? f.actif : 'border-border bg-white hover:border-accent/40')}>
                  <FIcon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', actif ? f.iconActif : 'text-muted-foreground')} />
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-medium', actif && f.key === 'pas_a_remonter' && 'text-destructive')}>{f.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{f.aide(cible?.ouvert ?? true)}</span>
                  </span>
                </button>
              )
            })}
          </div>

          {choix && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{choix.question}</label>
              <textarea autoFocus rows={3} value={commentaire} onChange={(e) => { setCommentaire(e.target.value); setErreur('') }}
                placeholder={choix.exemple}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          )}

          {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={fermer} disabled={mut.isPending}>Annuler</Button>
          <Button
            disabled={!pret || mut.isPending}
            onClick={() => cible && type && mut.mutate({ cle: cible.cle, depuis: cible.depuis, type, commentaire: commentaire.trim() })}
          >
            {mut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Envoyer à Tricobot
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

// Keyed on how the point was handled, not on the score alone: a point
// « Traité » with Tricobot corrected and a false alarm are both échecs.
const ISSUE_META: Record<'traite' | 'corrige' | 'fausse_alerte', { label: string; cls: string; icon: ComponentType<{ className?: string }> }> = {
  traite: { label: 'Traité', cls: 'border-green-500/30 bg-green-500/10 text-green-700', icon: CheckCheck },
  corrige: { label: 'Traité · Tricobot corrigé', cls: 'border-destructive/30 bg-destructive/5 text-destructive', icon: TricobotMascot },
  fausse_alerte: { label: 'Fausse alerte', cls: 'border-destructive/30 bg-destructive/10 text-destructive', icon: XCircle },
}
const issueDe = (t: Traitement) => t.issue === 'fausse_alerte' ? 'fausse_alerte' : t.note === 'echec' ? 'corrige' : 'traite'

export function HistoriqueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [erreur, setErreur] = useState('')
  const [aFormer, setAFormer] = useState<CiblePoint | null>(null)

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
            <p className="text-xs text-white/70 truncate">Agent Superviseur : chaque point signalé, et ce qui en a été fait</p>
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
            const m = t ? ISSUE_META[issueDe(t)] : null
            const MIcon = m?.icon
            return (
              <div key={p.id} className="rounded-lg border border-border/60 bg-card p-3 shadow-sm">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug">{sansTiretTitre(p.titre)}</p>
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
                      <span className="text-muted-foreground">· {t.par.nom}, {fmtDate(t.le)}</span>
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
                {p.lecons.map((l, i) => (
                  <div key={i} className="mt-1.5 flex items-start gap-1.5 text-xs">
                    <Lightbulb className="mt-0.5 h-3 w-3 flex-shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="italic">« {l.commentaire} » </span>
                      <span className="text-muted-foreground">· {l.par.nom}, {fmtDate(l.le)}</span>
                    </span>
                  </div>
                ))}
                {p.fermeLe && p.raisonFermeture && (
                  <p className="mt-1 text-[11px] text-green-700">Fermé par l’agent : {p.raisonFermeture}</p>
                )}
                <div className="mt-1.5 flex items-center gap-3">
                  {p.lien && (
                    <Link to={p.lien} onClick={onClose} className="inline-flex items-center gap-1 text-[11px] text-accent-blue hover:underline">
                      <ExternalLink className="h-3 w-3" />Ouvrir dans ETM
                    </Link>
                  )}
                  <div className="ml-auto">
                    <TricobotBouton label="Former Tricobot"
                      onClick={() => setAFormer({ cle: p.cle, depuis: p.depuis, titre: p.titre, ouvert: !p.fermeLe })} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
      <FormerTricobotDialog cible={aFormer} onClose={() => setAFormer(null)} />
    </Dialog>
  )
}
