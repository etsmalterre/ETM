import { useCallback, useMemo } from 'react'
import { usePermissions } from '@/contexts/PermissionsContext'
import {
  visibleSubmenus,
  visibleMainNavigation,
  canOpenScreen,
  firstVisibleScreenHref,
  type NavAccess,
  type SubMenuItem,
  type MainMenuItem,
} from '@/config/navigation'

/** The three permission reads every nav-filtering helper needs.
 *
 *  `hasRaw` is deliberately part of this: the per-screen keys are HIDES, and
 *  `has()` bypasses for effective admins — reading a hide key through it would
 *  hide every screen from the admin. */
function useNavAccessOpts(): NavAccess {
  const { isEffectiveAdmin, has, hasRaw } = usePermissions()
  return useMemo(() => ({ isEffectiveAdmin, has, hasRaw }), [isEffectiveAdmin, has, hasRaw])
}

/**
 * Returns a filter that drops submenu entries the current viewer may not open
 * (`adminOnly`, a `permission` key they lack, or a per-screen hide).
 *
 * Every nav surface — sidebar context menu, header tabs, mobile nav — must run
 * its submenu list through this so an entry never shows up in one surface and
 * not the others. Hiding is convenience only: the router redirects and, where
 * the data is confidential, the API enforces its own action key.
 */
export function useSubmenuFilter(): (submenus: SubMenuItem[]) => SubMenuItem[] {
  const opts = useNavAccessOpts()
  return useCallback((submenus: SubMenuItem[]) => visibleSubmenus(submenus, opts), [opts])
}

/** The main navigation as the current viewer sees it — menus they hold the
 *  grant for, each with only the screens they may open, empty menus dropped. */
export function useVisibleMainNavigation(): MainMenuItem[] {
  const opts = useNavAccessOpts()
  return useMemo(() => visibleMainNavigation(opts), [opts])
}

/** Route-guard helpers, used by AppShell to keep bookmarks and stale links
 *  from landing on a screen the viewer no longer has. */
export function useScreenAccess(): {
  canOpen: (href: string) => boolean
  firstVisibleUnder: (menuHref: string) => string | null
} {
  const opts = useNavAccessOpts()
  return useMemo(
    () => ({
      canOpen: (href: string) => canOpenScreen(href, opts),
      firstVisibleUnder: (menuHref: string) => firstVisibleScreenHref(menuHref, opts),
    }),
    [opts],
  )
}
