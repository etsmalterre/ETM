import { useCallback } from 'react'
import { usePermissions } from '@/contexts/PermissionsContext'
import { visibleSubmenus, type SubMenuItem } from '@/config/navigation'

/**
 * Returns a filter that drops submenu entries the current viewer may not open
 * (`adminOnly`, or a `permission` key they lack).
 *
 * Every nav surface — sidebar context menu, header tabs, mobile nav — must run
 * its submenu list through this so an entry never shows up in one surface and
 * not the others. Hiding is convenience only: the page and the API enforce the
 * same checks, so a direct URL is still refused.
 */
export function useSubmenuFilter(): (submenus: SubMenuItem[]) => SubMenuItem[] {
  const { isEffectiveAdmin, has } = usePermissions()
  return useCallback(
    (submenus: SubMenuItem[]) => visibleSubmenus(submenus, { isEffectiveAdmin, has }),
    [isEffectiveAdmin, has],
  )
}
