// ── Notifications widget ──────────────────────────────────────
// The notification centre on the dashboard. Since 2026-11-18 the centre is the
// bell of the header (components/layout/NotificationBell.tsx); this widget shows
// the SAME feed (components/notifications/NotificationsFeed.tsx) for those who
// keep it on their dashboard: never a second list.
//
// Port of the legacy FI_Notifications.wdw panel and of its gear window, the
// « Liste des abonnements » (FEN_Abonnement.wdw).

import { useState } from 'react'
import { Loader2, RotateCw, Settings } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { AbonnementsDialog, NotificationsFeed, useAbonnements, useRafraichirNotifications } from '@/components/notifications/NotificationsFeed'
import { WidgetFrame, useWidgetChrome } from './WidgetFrame'

export function NotificationsWidget() {
  const chrome = useWidgetChrome()
  const isEditing = chrome?.isEditing ?? false
  const [settingsOpen, setSettingsOpen] = useState(false)
  const catalogQuery = useAbonnements()
  const refreshMut = useRafraichirNotifications()

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
        <CardContent className="h-full rounded-b-lg bg-zinc-100/80 p-3">
          <NotificationsFeed isEditing={isEditing} onOuvrirAbonnements={() => setSettingsOpen(true)} />
        </CardContent>
      </WidgetFrame>

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
