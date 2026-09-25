import { Navigate } from 'react-router-dom'
import { settingsItem } from '@/config/navigation'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useSubmenuFilter } from '@/hooks/useSubmenuFilter'

/** `/settings` → the first Paramètres screen the viewer may open. A static
 *  redirect to Utilisateurs (admin-only) would bounce a non-admin holding only
 *  Outils onto an « accès refusé » page. Decides nothing while the permission
 *  fetch is in flight (CLAUDE.md § React rules). Shared with TRM via `@etm`. */
export function SettingsIndex() {
  const { isLoading } = usePermissions()
  const filterSubmenus = useSubmenuFilter()
  if (isLoading) return null
  const first = filterSubmenus(settingsItem.submenus)[0]
  return <Navigate to={first?.href ?? '/'} replace />
}
