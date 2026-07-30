import { useMemo, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { MobileNav } from './MobileNav'
import { HeaderActionsProvider } from '@/contexts/HeaderActionsContext'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useScreenAccess } from '@/hooks/useSubmenuFilter'
import { mainNavigation, DASHBOARD_ROUTE_PREFIX } from '@/config/navigation'

interface AppShellProps {
  children?: ReactNode
}

/** Screen-access route guard, in ONE place rather than a wrapper per route.
 *
 * Hiding a menu in the sidebar isn't enough — bookmarks, the browser history
 * and links inside the app all still point at the route. The shell is the
 * parent of every page, so deciding here means the page component never mounts.
 *
 * Returns the route to redirect to (`null` = let the page render), plus a
 * `waiting` flag: while the permission fetch is in flight we must not render a
 * gated page (it would flash, and fire its queries) nor redirect (everyone
 * would bounce to `/` on a cold load).
 */
function useScreenGuard(): { redirectTo: string | null; waiting: boolean } {
  const location = useLocation()
  const { isLoading } = usePermissions()
  const { canOpen, firstVisibleUnder } = useScreenAccess()

  return useMemo(() => {
    const path = location.pathname.replace(/\/+$/, '') || '/'

    // Never gated: `/` and the user's other dashboards (the landing page every
    // user keeps — its widgets have their own `dashboard_*` keys), and
    // Paramètres, which enforces its own admin guard.
    if (path === '/' || path.startsWith(DASHBOARD_ROUTE_PREFIX)) return { redirectTo: null, waiting: false }
    if (path === '/settings' || path.startsWith('/settings/')) return { redirectTo: null, waiting: false }

    const menu = mainNavigation.find((m) => m.href === path)
    const isScreen = mainNavigation.some((m) => m.submenus.some((s) => s.href === path))
    if (!menu && !isScreen) return { redirectTo: null, waiting: false } // unknown route — not ours

    if (isLoading) return { redirectTo: null, waiting: true }

    // A menu route is an index: send the user to the first screen they may
    // open under it, which is why the router's static `<Navigate>` redirects
    // can't be trusted on their own.
    if (menu) return { redirectTo: firstVisibleUnder(menu.href) ?? '/', waiting: false }

    return { redirectTo: canOpen(path) ? null : '/', waiting: false }
  }, [location.pathname, isLoading, canOpen, firstVisibleUnder])
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'
  const { redirectTo, waiting } = useScreenGuard()

  const content = redirectTo ? (
    <Navigate to={redirectTo} replace />
  ) : waiting ? (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-accent" />
    </div>
  ) : (
    children || <Outlet />
  )

  if (embed) {
    return (
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <main className="flex-1 min-h-0 p-4 flex flex-col overflow-hidden">
          {content}
        </main>
      </div>
    )
  }

  return (
    <HeaderActionsProvider>
    <div className="h-screen bg-background flex overflow-hidden">
      {/* Desktop Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="hidden lg:flex"
      />

      {/* Mobile Navigation */}
      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      {/* Main Content */}
      <div
        className={`flex-1 flex flex-col min-w-0 overflow-hidden transition-all duration-300 ${
          sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
        }`}
      >
        <Header
          onMenuClick={() => setMobileNavOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
        />

        <main className="flex-1 min-h-0 p-4 lg:p-6 flex flex-col overflow-hidden">
          {content}
        </main>
      </div>
    </div>
    </HeaderActionsProvider>
  )
}
