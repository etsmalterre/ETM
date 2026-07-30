// Permissions context — fetches the current user's granted permission keys
// from /api/permissions/me and exposes a fast has(key) check. Refetches when
// the active user changes (login, switch).
//
// Admins (user.isAdmin === true) get the full set of known keys from the API
// so the frontend doesn't need to special-case the bypass — has(anything)
// returns true automatically.

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { apiFetch } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'

interface MeResponse {
  /** Session level — admin cookie is present (true even when impersonating). */
  isAdmin: boolean
  /** Currently acting AS the admin (false during impersonation). Drives the
   *  permission bypass and the visibility of admin-only UI surfaces. */
  isEffectiveAdmin: boolean
  granted: string[]
}

interface PermissionsContextValue {
  granted: Set<string>
  /** Session-level admin (admin cookie present). True even during impersonation. */
  isAdmin: boolean
  /** True only when the current user IS the admin user (not impersonating). */
  isEffectiveAdmin: boolean
  isLoading: boolean
  has: (key: string) => boolean
  /** Raw membership test, WITHOUT the effective-admin bypass.
   *
   *  Required for negative keys — the screen-access axis stores per-screen
   *  HIDE keys (`hide_fils_stock`), and `has()` answers true for every key
   *  when the viewer is an effective admin, which would hide every screen
   *  from the admin. Use `has` for grants, `hasRaw` for hides. */
  hasRaw: (key: string) => boolean
  refresh: () => Promise<void>
}

const PermissionsContext = createContext<PermissionsContextValue | undefined>(undefined)

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoading: userLoading } = useUser()
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [isAdmin, setIsAdmin] = useState<boolean>(false)
  const [isEffectiveAdmin, setIsEffectiveAdmin] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const fetchPermissions = useCallback(async () => {
    if (!user) {
      setGranted(new Set())
      setIsAdmin(false)
      setIsEffectiveAdmin(false)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const me = await apiFetch<MeResponse>('/permissions/me')
      setGranted(new Set(me.granted))
      setIsAdmin(me.isAdmin)
      setIsEffectiveAdmin(me.isEffectiveAdmin)
    } catch (err) {
      console.warn('permissions/me failed:', err)
      setGranted(new Set())
      setIsAdmin(false)
      setIsEffectiveAdmin(false)
    } finally {
      setIsLoading(false)
    }
  }, [user])

  // Refetch whenever the identified user changes (login, switch, logout).
  useEffect(() => {
    if (userLoading) return
    void fetchPermissions()
  }, [fetchPermissions, userLoading, user?.IDutilisateur])

  const has = useCallback(
    (key: string): boolean => {
      // Bypass only for effective admins (currently acting as themselves).
      // An admin who is impersonating another user does NOT bypass — they
      // see the same gates as the impersonated user.
      if (isEffectiveAdmin) return true
      return granted.has(key)
    },
    [isEffectiveAdmin, granted],
  )

  const hasRaw = useCallback((key: string): boolean => granted.has(key), [granted])

  const value = useMemo<PermissionsContextValue>(
    () => ({ granted, isAdmin, isEffectiveAdmin, isLoading, has, hasRaw, refresh: fetchPermissions }),
    [granted, isAdmin, isEffectiveAdmin, isLoading, has, hasRaw, fetchPermissions],
  )

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>
}

export function usePermissions(): PermissionsContextValue {
  const ctx = useContext(PermissionsContext)
  if (!ctx) throw new Error('usePermissions must be used within a PermissionsProvider')
  return ctx
}

/** Convenience: returns true if the current user has the given permission
 *  key (or is admin). Re-renders when the answer changes. */
export function useHasPermission(key: string): boolean {
  const { has } = usePermissions()
  return has(key)
}
