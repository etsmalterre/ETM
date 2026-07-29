// ── Notifications widget ──────────────────────────────────────
// Port of the legacy FI_Notifications.wdw dashboard panel: the alerts of the
// subscriptions this user ticked, each dismissable with the eye button, and a
// gear opening the "Liste des abonnements" window (FEN_Abonnement.wdw).
//
// Backed by GET /api/abonnements/notifications, which recomputes the list from
// the source tables on every read — see apps/api/src/lib/abonnements.ts for why
// nothing is persisted and why hiding is per user here (legacy's
// `notifutilisateur.visible = 0` hid a card for the whole company).

import { useMemo, useState, type ComponentType } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell, BellOff, Settings, RotateCw, Loader2,
  ShieldCheck, CheckCircle2, Eye, EyeOff, Save, X,
} from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { WidgetFrame, useWidgetChrome } from './WidgetFrame'

interface Abonnement {
  id: number
  nom: string
  description: string
  icone: string
  implemented: boolean
}
interface NotificationRow {
  key: string
  abonnementId: number
  titre: string
  description: string
  icone: string
  hidden: boolean
}
interface FeedResponse {
  rows: NotificationRow[]
  hidden_count: number
  unimplemented: string[]
  subscribed_count: number
}
interface CatalogResponse {
  catalog: Abonnement[]
  subscribed: number[]
}

/** Legacy stores an icon FILENAME on both the subscription and the alert
 *  (`bobine_triangle.png`, `tricot.png`, `certificat.png`). Map it to the app's
 *  own icon set rather than shipping the legacy PNGs — an unknown name falls
 *  back to the bell so a new subscription type still renders. */
function iconFor(icone: string): ComponentType<{ className?: string }> {
  if (icone.startsWith('bobine')) return BobineIcon
  if (icone.startsWith('tricot')) return TmRollIcon
  if (icone.startsWith('certificat')) return ShieldCheck
  return Bell
}

/** The list can legitimately run to four figures (unaffected écru rolls alone).
 *  Rendering all of them would jank the whole dashboard, so the tail is
 *  summarised — and said out loud, never silently truncated. */
const RENDER_CAP = 150

export function NotificationsWidget() {
  const queryClient = useQueryClient()
  const chrome = useWidgetChrome()
  const isEditing = chrome?.isEditing ?? false

  const [showAll, setShowAll] = useState(false)
  const [typeFilter, setTypeFilter] = useState(0) // 0 = tous
  const [settingsOpen, setSettingsOpen] = useState(false)

  const catalogQuery = useQuery<CatalogResponse>({
    queryKey: ['abonnements'],
    queryFn: () => apiFetch('/abonnements'),
  })

  const feedQuery = useQuery<FeedResponse>({
    queryKey: ['abonnements-notifications', showAll],
    queryFn: () => apiFetch(`/abonnements/notifications?all=${showAll ? '1' : '0'}`),
  })

  const hideMut = useMutation({
    mutationFn: (vars: { key: string; hidden: boolean }) =>
      apiFetch('/abonnements/hidden', { method: 'PUT', body: JSON.stringify(vars) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
    },
  })

  const refreshMut = useMutation({
    mutationFn: () => apiFetch('/abonnements/refresh', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['abonnements-notifications'] })
    },
  })

  const rows = feedQuery.data?.rows ?? []
  const catalog = catalogQuery.data?.catalog ?? []

  /** Counts per subscription, for the type filter's labels. */
  const countsByAbo = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of rows) m.set(r.abonnementId, (m.get(r.abonnementId) ?? 0) + 1)
    return m
  }, [rows])

  // `0` is PopoverSelect's reserved "none" sentinel — it can never be a real
  // option (hideEmpty would swallow it and the trigger would read "— aucun —").
  // That suits us: "no type selected" IS "all types", so the unfiltered state
  // rides on the component's own empty row via `emptyLabel`.
  const typeOptions = useMemo(
    () => catalog
      .map((a) => ({ id: a.id, count: countsByAbo.get(a.id) ?? 0, nom: a.nom }))
      .filter((a) => a.count > 0)
      .map((a) => ({ id: a.id, primary: `${a.nom} (${a.count})` })),
    [catalog, countsByAbo],
  )

  const filtered = useMemo(
    () => (typeFilter === 0 ? rows : rows.filter((r) => r.abonnementId === typeFilter)),
    [rows, typeFilter],
  )
  const shown = filtered.slice(0, RENDER_CAP)
  const hiddenTail = filtered.length - shown.length

  const hiddenCount = feedQuery.data?.hidden_count ?? 0
  const subscribedCount = feedQuery.data?.subscribed_count ?? 0
  const unimplemented = feedQuery.data?.unimplemented ?? []

  return (
    <>
      <WidgetFrame
        // Tricobot delivers the alerts, so he stands on the band rather than a
        // generic bell — the same mascot that speaks in the Clients >
        // Commandes pricing nudge.
        icon={TricobotMascot}
        iconBleed
        title="Notifications"
        actions={
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => refreshMut.mutate()}
              disabled={refreshMut.isPending}
              title="Actualiser"
              className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {refreshMut.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RotateCw className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Gérer mes abonnements"
              className="rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <CardContent className="flex h-full flex-col gap-2 p-3">
          {/* Toolbar — count, the hidden-cards toggle, then the type filter.
              The toggle is legacy's "Afficher tout" checkbox, rendered as the
              app's counter pill (mps_designer §41): it only exists when there
              IS something hidden, and its count says how much. It lives here
              rather than on the navy band so the eye icon means exactly one
              thing in this widget — hiding a card. */}
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {feedQuery.isLoading
                ? 'Chargement…'
                : `${filtered.length} notification${filtered.length > 1 ? 's' : ''}`}
            </span>
            {hiddenCount > 0 && (
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
            {typeOptions.length > 1 && (
              <div className="ml-auto">
                <PopoverSelect
                  options={typeOptions}
                  value={typeFilter}
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
            {feedQuery.isLoading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            )}

            {feedQuery.isError && (
              <p className="py-8 text-center text-sm text-destructive">
                Impossible de charger les notifications.
              </p>
            )}

            {!feedQuery.isLoading && !feedQuery.isError && subscribedCount === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <BellOff className="mb-3 h-12 w-12 opacity-40" />
                <p className="text-sm">Aucun abonnement</p>
                {!isEditing && (
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setSettingsOpen(true)}>
                    <Settings className="mr-1.5 h-3.5 w-3.5" />
                    Choisir mes abonnements
                  </Button>
                )}
              </div>
            )}

            {!feedQuery.isLoading && !feedQuery.isError && subscribedCount > 0 && filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <CheckCircle2 className="mb-3 h-12 w-12 opacity-40 text-success" />
                <p className="text-sm">Rien à signaler</p>
                {!showAll && hiddenCount > 0 && (
                  <p className="mt-1 text-xs">
                    {hiddenCount} notification{hiddenCount > 1 ? 's' : ''} masquée{hiddenCount > 1 ? 's' : ''}.
                  </p>
                )}
              </div>
            )}

            {shown.map((row) => (
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
                … et {hiddenTail} autre{hiddenTail > 1 ? 's' : ''} — filtrez par type pour les voir.
              </p>
            )}

            {unimplemented.length > 0 && (
              <p className="pt-1 text-center text-xs italic text-muted-foreground">
                Abonnement{unimplemented.length > 1 ? 's' : ''} sans détection dans MPS&nbsp;:{' '}
                {unimplemented.join(', ')}.
              </p>
            )}
          </div>
        </CardContent>
      </WidgetFrame>

      <AbonnementsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        catalog={catalog}
        subscribed={catalogQuery.data?.subscribed ?? []}
        isLoading={catalogQuery.isLoading}
      />
    </>
  )
}

// ── One alert card ───────────────────────────────────────
// mps_designer §7 centre-panel item card: zinc surface, coloured left edge,
// icon box, title + description. The eye button is legacy's per-card dismissal
// (`visible = 0`), hover-revealed like every other per-item action in the app.
// The icon shows the ACTION, matching the widget-hide button in WidgetFrame:
// an eye-with-a-slash on a visible card means "hide this".

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
        'group rounded-lg border border-border/60 border-l-4 bg-zinc-100/80 p-3 transition-colors',
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
            // A hidden card keeps its button visible — it is the only way back.
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
// Writes the shared `abonnement_user` table, so ticking a box here also
// subscribes the user in the legacy WinDev app.

function AbonnementsDialog({
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
            Chaque abonnement fait apparaître ses alertes dans le widget Notifications.
            Ces choix sont partagés avec l'application MPS historique.
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
              return (
                <div
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3 shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-amber-400/10">
                      <Icon className="h-4 w-4 text-amber-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{a.nom}</p>
                      <p className="text-[11px] text-muted-foreground">{a.description}</p>
                      {!a.implemented && (
                        <p className="mt-0.5 text-[11px] italic text-muted-foreground/80">
                          Détection pas encore portée dans MPS&nbsp;NG.
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
