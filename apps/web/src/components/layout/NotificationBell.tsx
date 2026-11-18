// ── The notification centre's bell ────────────────────────────
// Top right of the header, left of the ticket button (Vincent 2026-11-18). The
// red bubble counts the TASKS of the person: what is red on the lists they
// subscribed to, their reminders due, the Superviseur points and the invoices
// they follow. A task = someone at Malterre must act now (mps_designer §41);
// the plain notifications (a stock at its minimum…) are listed in the panel,
// never counted.
//
// The panel shows the same feed as the dashboard widget
// (components/notifications/NotificationsFeed.tsx).
//
// ETM only: TRM has its own header and no notification centre yet.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, Loader2, RotateCw, Settings, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHasPermission } from '@/contexts/PermissionsContext'
import {
  AbonnementsDialog, CLE_TACHES, NotificationsFeed, chargerTaches, useAbonnements, useRafraichirNotifications,
  type FeedResponse,
} from '@/components/notifications/NotificationsFeed'

/** The count follows the work: read again every 2 minutes and whenever the person comes back to the tab. */
const SONDAGE_MS = 2 * 60_000

const boutonBande = 'h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white'

export function NotificationBell() {
  // The API refuses the feed without this right (it names client orders and stock levels).
  const autorise = useHasPermission('dashboard_notifications')
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const taches = useQuery<FeedResponse>({
    queryKey: CLE_TACHES,
    queryFn: chargerTaches,
    enabled: autorise,
    staleTime: 30_000,
    refetchInterval: SONDAGE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const catalogQuery = useAbonnements(autorise)
  const refreshMut = useRafraichirNotifications()

  // Escape closes the panel, unless a dialog opened from it is on top (the dialog takes the key).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.querySelectorAll('[data-dialog-root]').length === 0) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!autorise) return null

  const rouges = taches.data?.rouges ?? 0
  const title = rouges > 0
    ? `${rouges} tâche${rouges > 1 ? 's' : ''} à faire`
    : 'Notifications'

  return (
    <>
      <div className="relative">
        <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} title={title} aria-expanded={open}>
          <Bell className="h-5 w-5" />
          <span className="sr-only">{title}</span>
        </Button>
        {rouges > 0 && (
          <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white/80 shadow-sm pointer-events-none">
            {rouges > 99 ? '99+' : rouges}
          </span>
        )}
      </div>

      {/* Portalled to <body>: the header is a stacking context (sticky z-30), a panel inside it
          would slide under the screens' own drawers. */}
      {open && createPortal(
        <>
          {/* A click anywhere else closes the panel. A dialog opened from a card is portalled after
              this layer, so it stays above it and its own clicks never reach it. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="region"
            aria-label="Centre de notifications"
            className="fixed right-2 top-14 z-50 mt-1 flex h-[min(680px,calc(100dvh-4.5rem))] w-[440px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg bg-primary shadow-xl"
          >
            {/* Header band: mps_designer §43 */}
            <div className="flex flex-shrink-0 items-center gap-2.5 rounded-t-lg border-b-2 border-gold bg-primary px-4 py-2.5">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gold text-gold-foreground shadow-sm">
                <Bell className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-heading font-bold tracking-tight text-primary-foreground">Notifications</h2>
                <p className="truncate text-xs text-white/70">
                  {rouges > 0 ? `${rouges} tâche${rouges > 1 ? 's' : ''} à faire` : 'Rien à faire pour l’instant'}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <Button variant="ghost" size="icon" className={boutonBande} title="Actualiser" disabled={refreshMut.isPending} onClick={() => refreshMut.mutate()}>
                  {refreshMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="icon" className={boutonBande} title="Gérer mes abonnements" onClick={() => setSettingsOpen(true)}>
                  <Settings className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className={boutonBande} title="Fermer" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 rounded-b-lg bg-zinc-100 p-3">
              <NotificationsFeed
                vueInitiale="a_faire"
                onOuvrirAbonnements={() => setSettingsOpen(true)}
                onNaviguer={() => setOpen(false)}
              />
            </div>
          </div>
        </>,
        document.body,
      )}

      <AbonnementsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        catalog={catalogQuery.data?.catalog ?? []}
        subscribed={catalogQuery.data?.subscribed ?? []}
        isLoading={catalogQuery.isLoading}
      />
    </>
  )
}
