import { Navigate } from 'react-router-dom'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useScreenAccess } from '@/hooks/useSubmenuFilter'

/** `/settings` → the first Paramètres screen the viewer may open. A static
 *  redirect to Utilisateurs (admin-only) would bounce a non-admin granted only
 *  Outils onto an « accès refusé » page. Decides nothing while the permission
 *  fetch is in flight (CLAUDE.md § React rules). Shared with TRM via `@etm`:
 *  its `@/` imports resolve to the host app's own navigation. */
export function SettingsIndex() {
  const { isLoading } = usePermissions()
  const { firstVisibleUnder } = useScreenAccess()
  if (isLoading) return null
  return <Navigate to={firstVisibleUnder('/settings') ?? '/'} replace />
}
