// ── The notification centre's feed ────────────────────────────
// One feed, two surfaces (Vincent 2026-11-18): the bell of the header
// (components/layout/NotificationBell.tsx) and the dashboard's Notifications
// widget. Never a second list: both mount <NotificationsFeed>.
//
// Backed by GET /api/abonnements/notifications. A row is either a TASK
// (`niveau: 'rouge'`: someone at Malterre must act now, e.g. a red item of a list
// the person subscribed to, a Superviseur point, an invoice to check, a
// reminder due) or a plain notification of the legacy detectors (a state:
// a stock at its minimum, a piece without an order). The bell counts the tasks.
// A task left red more than 2 working days is `retard`, and also reaches
// whoever subscribed to « Tâches en retard ».
//
// The legacy rows port FI_Notifications.wdw: recomputed on every read, hidden
// per user with the eye (apps/api/src/lib/abonnements.ts).

import { useMemo, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock, Bell, BellOff, CalendarClock, CheckCheck, CheckCircle2, ChevronRight, ClipboardCheck, ClipboardList,
  Clock, Eye, EyeOff, Factory, FlaskConical, History, Hourglass, Loader2, ReceiptText, Save, Settings, ShieldCheck, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { FormerTricobotDialog, HistoriqueDialog, SuperviseurPointCard, TraiteDialog, type CiblePoint, type PointSuperviseur } from '@/components/dashboard/SuperviseurPoints'
import { RappelFaitDialog, RappelRepousserDialog } from '@/components/rappels/RappelDialogs'
import { aujourdhuiIso, dateFr, type Rappel } from '@/components/rappels/rappels'
import { useUser } from '@/contexts/UserContext'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

/** ETM-only subscription (apps/api/src/lib/abonnements-etm.ts): the agent
 *  Superviseur's points, handled right on their card. */
const ABONNEMENT_SUPERVISEUR = 100001
/** The subscriptions born in ETM (ids ≥ 100001): the WinDev app never had them. */
const estPropreEtm = (id: number) => id >= 100001

export interface Abonnement {
  id: number
  nom: string
  description: string
  icone: string
  implemented: boolean
}
export interface NotificationRow {
  key: string
  abonnementId: number
  titre: string
  description: string
  icone: string
  hidden: boolean
  /** 'rouge' = a task: someone at Malterre must act now. null = a plain notification (a state). */
  niveau?: 'rouge' | null
  /** A task: first day seen red (YYYYMMDD), working days since, and « more than 2 ». */
  depuis?: string | null
  jours?: number
  retard?: boolean
  /** « Tâches en retard »: who the task is with (the list's subscribers, the reminder's person). */
  chez?: string[]
  /** Set on a Superviseur point: the card carries Traité / Former Tricobot. */
  superviseur?: PointSuperviseur
  /** Set on a reminder due: the card carries Fait / Repousser. */
  rappel?: { id: number; echeance: string; pour_id: number; pour: string; par: string; cree_le: string }
  /** Where the item is handled: clicking the card opens it. */
  lien?: string | null
}
export interface FeedResponse {
  rows: NotificationRow[]
  /** How many rows are tasks. */
  rouges?: number
  /** The person's open reminders, due or to come (the « Mes rappels » button). */
  rappels_ouverts?: number
  hidden_count: number
  unimplemented: string[]
  subscribed_count: number
}
export interface CatalogResponse {
  catalog: Abonnement[]
  subscribed: number[]
}

/** The feed's two views: the tasks only, or everything (tasks first, then the plain notifications). */
export type VueFeed = 'a_faire' | 'tout'

/** The tasks alone: the bell's count and the « À faire » view share this cache entry. */
export const CLE_TACHES = ['abonnements-notifications', 'rouge'] as const
export const chargerTaches = () => apiFetch<FeedResponse>('/abonnements/notifications?rouge=1')

/** Legacy stores an icon FILENAME on both the subscription and the alert
 *  (`bobine_triangle.png`, `tricot.png`, `certificat.png`). Map it to the app's
 *  own icon set rather than shipping the legacy PNGs: an unknown name falls
 *  back to the bell so a new subscription type still renders. */
export function iconFor(icone: string): ComponentType<{ className?: string }> {
  if (icone.startsWith('bobine')) return BobineIcon
  if (icone.startsWith('tricot')) return TmRollIcon
  if (icone.startsWith('certificat')) return ShieldCheck
  if (icone === 'superviseur') return ClipboardCheck
  if (icone === 'facture_sst') return ReceiptText
  if (icone === 'commande_client') return ClipboardList
  if (icone === 'commande_sst') return Factory
  if (icone === 'lot') return FlaskConical
  if (icone === 'commande_fil') return BobineIcon
  if (icone === 'retard') return Hourglass
  // The alarm clock is the reminder's icon everywhere (button, dialog, card, Journal); the bell is the centre's.
  if (icone === 'rappel') return AlarmClock
  return Bell
}

/** The list can legitimately run to four figures (unaffected écru rolls alone).
 *  Rendering all of them would jank the whole dashboard, so the tail is
 *  summarised, and said out loud, never silently truncated. */
const RENDER_CAP = 150

/** The refresh button of both surfaces: forget the server's memo, read the lists again. */
export function useRafraichirNotifications() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch('/abonnements/refresh', { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] }) },
  })
}

export function useAbonnements(enabled = true) {
  return useQuery<CatalogResponse>({ queryKey: ['abonnements'], queryFn: () => apiFetch('/abonnements'), enabled })
}

export function NotificationsFeed({ vueInitiale = 'tout', isEditing = false, onOuvrirAbonnements, onNaviguer }: {
  /** The bell opens on the tasks, the widget on everything. */
  vueInitiale?: VueFeed
  /** The dashboard is being rearranged: no gesture that opens a dialog. */
  isEditing?: boolean
  onOuvrirAbonnements: () => void
  /** A card took the person to another screen (the bell closes its panel). */
  onNaviguer?: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [vue, setVue] = useState<VueFeed>(vueInitiale)
  const [showAll, setShowAll] = useState(false)
  // « Mes rappels » (Vincent 2026-11-18): off by default; on, the list shows every open reminder of
  // the person, those to come included. A reminder put for in 6 months is otherwise invisible until
  // its day, and nobody could check what they had planned.
  const [rappelsSeuls, setRappelsSeuls] = useState(false)
  const { user } = useUser()
  const [typeFilter, setTypeFilter] = useState(0) // 0 = tous
  const [historiqueOpen, setHistoriqueOpen] = useState(false)
  const [aTraiter, setATraiter] = useState<{ titre: string; point: PointSuperviseur } | null>(null)
  const [aFormer, setAFormer] = useState<CiblePoint | null>(null)
  const [rappelFait, setRappelFait] = useState<{ id: number; titre: string; observation: string } | null>(null)
  const [rappelARepousser, setRappelARepousser] = useState<{ id: number; echeance: string } | null>(null)

  const catalogQuery = useAbonnements()
  const feedQuery = useQuery<FeedResponse>({
    queryKey: vue === 'a_faire' ? CLE_TACHES : ['abonnements-notifications', showAll],
    queryFn: () => (vue === 'a_faire' ? chargerTaches() : apiFetch(`/abonnements/notifications?all=${showAll ? '1' : '0'}`)),
  })

  const hideMut = useMutation({
    mutationFn: (vars: { key: string; hidden: boolean }) =>
      apiFetch('/abonnements/hidden', { method: 'PUT', body: JSON.stringify(vars) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] }) },
  })

  const mesRappels = useQuery<{ rappels: Rappel[]; moi: number }>({
    // Under ['rappels']: every reminder gesture refreshes it (useGestesRappel).
    queryKey: ['rappels', 'miens'],
    queryFn: () => apiFetch('/rappels/miens'),
    enabled: rappelsSeuls,
  })
  const rappelsOuverts = feedQuery.data?.rappels_ouverts ?? 0
  // The button hides at 0: a view armed on an emptied list must not survive it (mps_designer §41).
  const vueRappels = rappelsSeuls && (rappelsOuverts > 0 || mesRappels.isLoading)

  const rows = useMemo<NotificationRow[]>(() => {
    if (!vueRappels) return feedQuery.data?.rows ?? []
    const aujourdhui = aujourdhuiIso()
    const moi = mesRappels.data?.moi ?? user?.IDutilisateur ?? 0
    return (mesRappels.data?.rappels ?? []).map((r) => ({
      key: `rappel:${r.id}`,
      abonnementId: 0,
      titre: r.objet_libelle,
      description: r.observation,
      icone: 'rappel',
      hidden: false,
      // Due = a task, red. To come = nothing to do yet, neutral.
      niveau: r.echeance <= aujourdhui ? 'rouge' : null,
      lien: r.lien,
      rappel: { id: r.id, echeance: r.echeance, pour_id: r.pour_id, pour: r.pour, par: r.par, cree_le: r.cree_le },
      // Put for someone else: say who it waits for.
      chez: r.pour_id !== moi && r.pour ? [r.pour] : undefined,
    }))
  }, [vueRappels, feedQuery.data, mesRappels.data, user?.IDutilisateur])
  const chargement = vueRappels ? mesRappels.isLoading : feedQuery.isLoading
  const catalog = catalogQuery.data?.catalog ?? []

  /** Counts per subscription, for the type filter's labels. */
  const countsByAbo = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of rows) m.set(r.abonnementId, (m.get(r.abonnementId) ?? 0) + 1)
    return m
  }, [rows])

  // `0` is PopoverSelect's reserved "none" sentinel: it can never be a real
  // option (hideEmpty would swallow it and the trigger would read "— aucun —").
  // That suits us: "no type selected" IS "all types", so the unfiltered state
  // rides on the component's own empty row via `emptyLabel`.
  const typeOptions = useMemo(() => {
    const noms = new Map(catalog.map((a) => [a.id, a.nom]))
    return [...countsByAbo.entries()]
      // A reminder has no subscription, a late task may come from a list the person does not follow.
      .map(([id, count]) => ({ id, primary: `${noms.get(id) ?? (rows.find((r) => r.abonnementId === id)?.rappel ? 'Rappels' : 'Autres tâches')} (${count})` }))
      .sort((a, b) => a.id - b.id)
  }, [catalog, countsByAbo, rows])

  // A filter on a type that just emptied (its last task was handled) must not leave a blank list.
  const filtreActif = typeFilter !== 0 && countsByAbo.has(typeFilter) ? typeFilter : 0
  const filtered = useMemo(
    () => (filtreActif === 0 ? rows : rows.filter((r) => r.abonnementId === filtreActif)),
    [rows, filtreActif],
  )
  const shown = filtered.slice(0, RENDER_CAP)
  const hiddenTail = filtered.length - shown.length

  const hiddenCount = vue === 'tout' ? (feedQuery.data?.hidden_count ?? 0) : 0
  const subscribedCount = feedQuery.data?.subscribed_count ?? 0
  const unimplemented = feedQuery.data?.unimplemented ?? []
  const suitSuperviseur = (catalogQuery.data?.subscribed ?? []).includes(ABONNEMENT_SUPERVISEUR)
  const rouges = feedQuery.data?.rouges ?? rows.filter((r) => r.niveau === 'rouge').length

  const ouvrir = (lien: string) => {
    navigate(lien)
    onNaviguer?.()
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2">
        {/* The two views (mps_designer §5 segmented filter): the tasks, or everything. */}
        <div className="flex flex-shrink-0 gap-1">
          {([['a_faire', 'À faire'], ['tout', 'Tout']] as const).map(([cle, libelle]) => (
            <button
              key={cle}
              type="button"
              onClick={() => { setVue(cle); setTypeFilter(0); setRappelsSeuls(false) }}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-xs transition-colors',
                vue === cle && !vueRappels ? 'bg-accent font-medium text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {libelle}{cle === 'a_faire' && !feedQuery.isLoading && rouges > 0 ? ` (${rouges})` : ''}
            </button>
          ))}
        </div>

        {/* Toolbar: count, the hidden-cards toggle, then the type filter.
            The toggle is legacy's "Afficher tout" checkbox, rendered as the
            app's counter pill (mps_designer §41): it only exists when there
            IS something hidden, and its count says how much. */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {chargement
              ? 'Chargement…'
              : vueRappels
                ? `${filtered.length} rappel${filtered.length > 1 ? 's' : ''} en cours`
                : vue === 'a_faire'
                  ? `${filtered.length} tâche${filtered.length > 1 ? 's' : ''}`
                  : `${filtered.length} notification${filtered.length > 1 ? 's' : ''}`}
          </span>
          {rappelsOuverts > 0 && (
            <button
              type="button"
              onClick={() => setRappelsSeuls((v) => !v)}
              aria-pressed={vueRappels}
              title={vueRappels
                ? 'Revenir aux notifications'
                : `Voir mes ${rappelsOuverts} rappel${rappelsOuverts > 1 ? 's' : ''} en cours, à venir compris`}
              className={cn(
                'inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border px-1.5',
                'text-xs font-semibold tabular-nums transition-colors',
                vueRappels
                  ? 'border-accent bg-accent text-accent-foreground shadow-sm'
                  : 'border-accent/30 bg-accent/10 text-amber-800 hover:bg-accent/20',
              )}
            >
              <AlarmClock className="h-3 w-3" />
              {rappelsOuverts}
            </button>
          )}
          {hiddenCount > 0 && !vueRappels && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-pressed={showAll}
              title={showAll
                ? 'Ne plus afficher les notifications masquées'
                : `Afficher aussi les ${hiddenCount} notification${hiddenCount > 1 ? 's' : ''} masquée${hiddenCount > 1 ? 's' : ''}`}
              className={cn(
                'inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border px-1.5',
                'text-xs font-semibold tabular-nums transition-colors',
                showAll
                  ? 'border-accent bg-accent text-accent-foreground shadow-sm'
                  : 'border-accent/30 bg-accent/10 text-amber-800 hover:bg-accent/20',
              )}
            >
              <EyeOff className="h-3 w-3" />
              {hiddenCount}
            </button>
          )}
          {suitSuperviseur && !isEditing && (
            <button
              type="button"
              onClick={() => setHistoriqueOpen(true)}
              title="Historique des points du Superviseur"
              className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border border-border/60 bg-white px-1.5 text-xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
            >
              <History className="h-3 w-3" />
              Historique
            </button>
          )}
          {typeOptions.length > 1 && !vueRappels && (
            <div className="ml-auto">
              <PopoverSelect
                options={typeOptions}
                value={filtreActif}
                onChange={setTypeFilter}
                emptyLabel={`Tous les types (${rows.length})`}
                size="sm"
                widthClass="w-[190px]"
              />
            </div>
          )}
        </div>

        {/* Feed */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent space-y-2 p-1">
          {chargement && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {(vueRappels ? mesRappels.isError : feedQuery.isError) && (
            <p className="py-8 text-center text-sm text-destructive">
              Impossible de charger les notifications.
            </p>
          )}

          {/* A reminder reaches its person without any subscription: « aucun abonnement » only when the list is empty too. */}
          {!vueRappels && !feedQuery.isLoading && !feedQuery.isError && subscribedCount === 0 && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <BellOff className="mb-3 h-12 w-12 opacity-40" />
              <p className="text-sm">Aucun abonnement</p>
              {!isEditing && (
                <Button variant="outline" size="sm" className="mt-3" onClick={onOuvrirAbonnements}>
                  <Settings className="mr-1.5 h-3.5 w-3.5" />
                  Choisir mes abonnements
                </Button>
              )}
            </div>
          )}

          {!vueRappels && !feedQuery.isLoading && !feedQuery.isError && subscribedCount > 0 && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <CheckCircle2 className="mb-3 h-12 w-12 opacity-40 text-success" />
              <p className="text-sm">{vue === 'a_faire' ? 'Rien à faire pour l’instant' : 'Rien à signaler'}</p>
              {vue === 'tout' && !showAll && hiddenCount > 0 && (
                <p className="mt-1 text-xs">
                  {hiddenCount} notification{hiddenCount > 1 ? 's' : ''} masquée{hiddenCount > 1 ? 's' : ''}.
                </p>
              )}
            </div>
          )}

          {shown.map((row) => row.superviseur ? (
            <SuperviseurPointCard
              key={row.key}
              titre={row.titre}
              description={row.description}
              point={row.superviseur}
              onTraiter={() => setATraiter({ titre: row.titre, point: row.superviseur! })}
              onFormer={() => setAFormer({ cle: row.superviseur!.cle, depuis: row.superviseur!.depuis, titre: row.titre, ouvert: true })}
            />
          ) : row.niveau === 'rouge' || row.rappel ? (
            <TacheCard
              key={row.key}
              row={row}
              onOuvrir={row.lien ? () => ouvrir(row.lien!) : undefined}
              onFait={row.rappel && !isEditing ? () => setRappelFait({ id: row.rappel!.id, titre: row.titre, observation: row.description }) : undefined}
              onRepousser={row.rappel && !isEditing ? () => setRappelARepousser({ id: row.rappel!.id, echeance: row.rappel!.echeance }) : undefined}
            />
          ) : (
            <NotificationCard
              key={row.key}
              row={row}
              onToggleHidden={() => hideMut.mutate({ key: row.key, hidden: !row.hidden })}
              isPending={hideMut.isPending && hideMut.variables?.key === row.key}
            />
          ))}

          {hiddenTail > 0 && (
            // Never truncate silently: say what is not on screen and how to
            // get to it (the type filter narrows the list under the cap).
            <p className="pt-1 text-center text-xs italic text-muted-foreground">
              … et {hiddenTail} autre{hiddenTail > 1 ? 's' : ''}, filtrez par type pour les voir.
            </p>
          )}

          {unimplemented.length > 0 && (
            <p className="pt-1 text-center text-xs italic text-muted-foreground">
              Abonnement{unimplemented.length > 1 ? 's' : ''} sans détection dans MPS&nbsp;:{' '}
              {unimplemented.join(', ')}.
            </p>
          )}
        </div>
      </div>

      <TraiteDialog cible={aTraiter} onClose={() => setATraiter(null)} />
      <FormerTricobotDialog cible={aFormer} onClose={() => setAFormer(null)} />
      <HistoriqueDialog open={historiqueOpen} onClose={() => setHistoriqueOpen(false)} />
      <RappelFaitDialog rappel={rappelFait} onClose={() => setRappelFait(null)} />
      <RappelRepousserDialog rappel={rappelARepousser} onClose={() => setRappelARepousser(null)} />
    </>
  )
}

// ── One task card ────────────────────────────────────────
// Red = someone at Malterre must act now (mps_designer §41): the card prints
// the ACTION in red, as its list does, and opens the item where it is handled.
// A reminder also carries its two gestures, « Fait » and « Repousser ».

function TacheCard({ row, onOuvrir, onFait, onRepousser }: {
  row: NotificationRow
  onOuvrir?: () => void
  onFait?: () => void
  onRepousser?: () => void
}) {
  const Icon = iconFor(row.icone)
  const jours = row.jours ?? 0
  // A reminder still to come (« Mes rappels »): nothing to do yet, so neutral, never red (§41).
  const rouge = row.niveau === 'rouge'
  const corps = (
    <div className="flex items-start gap-2">
      <div className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md', rouge ? 'bg-destructive/10' : 'bg-muted')}>
        <Icon className={cn('h-3.5 w-3.5', rouge ? 'text-destructive/80' : 'text-muted-foreground')} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={row.titre}>{row.titre}</p>
        <p className={cn('text-xs', rouge ? 'font-medium text-red-600' : 'text-foreground/80', row.rappel ? 'whitespace-pre-line line-clamp-3' : 'truncate')} title={row.description}>
          {row.description}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {row.rappel && (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="h-3 w-3" />Rappel du {dateFr(row.rappel.echeance)}{row.rappel.par ? `, posé par ${row.rappel.par}` : ''}
            </span>
          )}
          {!row.rappel && row.depuis && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />{jours === 0 ? 'depuis aujourd’hui' : `depuis ${jours} j ouvré${jours > 1 ? 's' : ''}`}
            </span>
          )}
          {row.retard && (
            <span className="rounded-full border border-red-200 bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">En retard</span>
          )}
          {row.chez && (
            <span title="Les personnes abonnées à cette liste, ou celle à qui le rappel s’adresse">
              {row.chez.length > 0 ? `${row.rappel ? 'pour' : 'chez'} ${row.chez.join(', ')}` : 'suivi par personne'}
            </span>
          )}
        </div>
      </div>
      {onOuvrir && <ChevronRight className="mt-1.5 h-4 w-4 flex-shrink-0 text-muted-foreground group-hover:text-accent" />}
    </div>
  )
  return (
    <div className={cn(
      'group rounded-lg border border-border/60 border-l-4 bg-card p-3 shadow-sm transition-colors hover:border-accent/40',
      rouge ? 'border-l-destructive/60' : 'border-l-border',
    )}>
      {onOuvrir ? (
        <div
          role="button"
          tabIndex={0}
          onClick={onOuvrir}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOuvrir() } }}
          title="Ouvrir"
          className="cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {corps}
        </div>
      ) : corps}
      {(onFait || onRepousser) && (
        <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/50 pt-2">
          {onRepousser && (
            <button
              type="button" onClick={onRepousser} title="Donner une nouvelle date à ce rappel"
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-white px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
            >
              <CalendarClock className="h-3.5 w-3.5" />Repousser
            </button>
          )}
          {onFait && (
            <button
              type="button" onClick={onFait} title="Ce qui était à faire est fait"
              className="inline-flex h-6 items-center gap-1 rounded-md bg-success px-2.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-success/90"
            >
              <CheckCheck className="h-3.5 w-3.5" />Fait
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── One plain notification ───────────────────────────────
// A state, not a task: amber edge, never counted. The eye button is legacy's
// per-card dismissal (`visible = 0`), hover-revealed like every other per-item
// action in the app. The icon shows the ACTION: an eye-with-a-slash on a
// visible card means "hide this".

function NotificationCard({
  row, onToggleHidden, isPending,
}: {
  row: NotificationRow
  onToggleHidden: () => void
  isPending: boolean
}) {
  const Icon = iconFor(row.icone)
  return (
    <div
      className={cn(
        'group rounded-lg border border-border/60 border-l-4 bg-card p-3 shadow-sm transition-colors',
        row.hidden ? 'border-l-border opacity-60' : 'border-l-amber-400/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
              row.hidden ? 'bg-muted' : 'bg-amber-400/10',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', row.hidden ? 'text-muted-foreground' : 'text-amber-600')} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={row.titre}>{row.titre}</p>
            <p className="truncate text-[11px] text-muted-foreground" title={row.description}>
              {row.description}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleHidden}
          disabled={isPending}
          title={row.hidden ? 'Réafficher cette notification' : 'Masquer cette notification'}
          aria-label={row.hidden ? 'Réafficher cette notification' : 'Masquer cette notification'}
          className={cn(
            'flex-shrink-0 rounded-md p-1.5 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            // A hidden card keeps its button visible: it is the only way back.
            row.hidden
              ? 'text-muted-foreground hover:bg-accent/10 hover:text-accent'
              : 'text-muted-foreground opacity-0 hover:bg-accent/10 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          {isPending
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : row.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

// ── "Liste des abonnements" dialog (legacy FEN_Abonnement.wdw) ──
// The legacy subscriptions live in the shared `abonnement_user` table; the
// ETM-only ones (the red families, Superviseur, invoices) in their own store.

export function AbonnementsDialog({
  open, onClose, catalog, subscribed, isLoading,
}: {
  open: boolean
  onClose: () => void
  catalog: Abonnement[]
  subscribed: number[]
  isLoading: boolean
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Set<number> | null>(null)
  const [error, setError] = useState('')

  // Hydrate the draft from the server value on first open, and drop it on
  // close so a re-open never shows a stale tick.
  const current = draft ?? new Set(subscribed)

  const saveMut = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch('/abonnements/me', { method: 'PUT', body: JSON.stringify({ subscribed: ids }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements'] })
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
      setDraft(null)
      onClose()
    },
    onError: () => setError("L'enregistrement a échoué."),
  })

  function toggle(id: number) {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setDraft(next)
    setError('')
  }

  function handleClose() {
    setDraft(null)
    setError('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-2xl" onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-accent" />
            Liste des abonnements
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <p className="text-xs text-muted-foreground">
            Abonnez-vous aux listes dont vous avez la charge : chaque élément rouge y devient une tâche dans votre centre de notifications.
            Une tâche restée rouge plus de 2 jours ouvrés est aussi signalée à la direction.
          </p>

          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {!isLoading && catalog.length === 0 && (
            <p className="py-8 text-center text-sm italic text-muted-foreground">
              Aucun abonnement disponible.
            </p>
          )}

          <div className="max-h-[50vh] space-y-2 overflow-y-auto scrollbar-transparent p-1">
            {catalog.map((a) => {
              const Icon = iconFor(a.icone)
              const on = current.has(a.id)
              const tache = estPropreEtm(a.id)
              return (
                <div
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3 shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md', tache ? 'bg-destructive/10' : 'bg-amber-400/10')}>
                      <Icon className={cn('h-4 w-4', tache ? 'text-destructive/80' : 'text-amber-600')} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{a.nom}</p>
                      <p className="text-[11px] text-muted-foreground">{a.description}</p>
                      {!tache && (
                        <p className="mt-0.5 text-[11px] italic text-muted-foreground/80">
                          Simple notification : listée, jamais comptée comme une tâche.
                        </p>
                      )}
                      {!a.implemented && (
                        <p className="mt-0.5 text-[11px] italic text-muted-foreground/80">
                          Détection pas encore portée dans ETM.
                        </p>
                      )}
                    </div>
                  </div>
                  {/* mps_designer §35 inline toggle pill. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={a.nom}
                    onClick={() => toggle(a.id)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      on ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
                        on ? 'translate-x-[18px]' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                </div>
              )
            })}
          </div>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={handleClose} disabled={saveMut.isPending}>
            <X className="mr-1.5 h-4 w-4" />
            Annuler
          </Button>
          <Button
            onClick={() => saveMut.mutate(Array.from(current))}
            disabled={saveMut.isPending || isLoading}
          >
            {saveMut.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Save className="mr-1.5 h-4 w-4" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
