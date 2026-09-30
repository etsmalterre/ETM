// User context — the account behind this browser's session (password login
// since 2026-09-30, apps/api/src/routes/auth.ts). Wraps the whole app inside
// main.tsx so any component can call useUser(). Shared with the TRM web app,
// whose contexts/UserContext.tsx re-exports this module through `@etm`.
//
// On mount: GET /api/auth/me. A valid session → the user; 401 → null, and
// AuthGate shows the login screen.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api'

export interface CurrentUser {
  IDutilisateur: number
  prenom: string | null
  nom: string | null
  IDexpediteur?: number | null
  identifiant?: string | null
  email?: string | null
  /** 'poste' = a station account (Visitage…) on an enrolled PC; 'appareils'
   *  = atelier phones / pointeuses — member of no app, the gate refuses it. */
  typeCompte?: 'personne' | 'poste' | 'appareils'
  /** The session belongs to an admin — stays true while they « Voir comme »
   *  someone else, so the header keeps the way back. */
  isAdmin?: boolean
  /** An admin set a temporary password: the app asks for a new one first. */
  doitChangerMdp?: boolean
  sessionType?: 'navigateur' | 'poste' | null
  /** Set while an admin looks at the app as this user: the admin's own identity. */
  voirComme?: { IDutilisateur: number; prenom: string | null; nom: string | null } | null
  /** The apps this account belongs to — AuthGate refuses a non-member. */
  apps?: AppCode[]
}

/** Which app this bundle is: ETM (ETS Malterre) or TRM (Tricotage Malterre). */
export type AppCode = 'etm' | 'trm'

export const APP_NAMES: Record<AppCode, string> = {
  etm: 'ETS Malterre',
  trm: 'Tricotage Malterre',
}

// Set once by AuthGate (main.tsx passes the app), read by the shared auth
// components that must know which app they sit in (« Voir comme » lists the
// app's members only).
const AppCodeContext = createContext<AppCode | undefined>(undefined)
export const AppCodeProvider = AppCodeContext.Provider

export function useAppCode(): AppCode {
  const app = useContext(AppCodeContext)
  if (!app) throw new Error('useAppCode must be used below AuthGate')
  return app
}

interface UserContextValue {
  user: CurrentUser | null
  isLoading: boolean
  /** Identifiant (or email) + password. Throws the API error (err.body.message). */
  login: (identifiant: string, motDePasse: string) => Promise<void>
  /** Name picker — only while the server's AUTH_PICKER transition flag is on. */
  loginPicker: (id: number) => Promise<void>
  /** Enrol this PC as a station account with an admin's one-time code. */
  /** `app`: the app whose login screen enrols the PC — recorded on it. */
  enrolerPoste: (code: string, app: AppCode) => Promise<void>
  logout: () => Promise<void>
  /** Re-read /auth/me (after a password change, « Voir comme »…). */
  refresh: () => Promise<void>
}

const UserContext = createContext<UserContextValue | undefined>(undefined)

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const refresh = useCallback(async () => {
    try {
      setUser(await apiFetch<CurrentUser>('/auth/me'))
    } catch (err) {
      if ((err as { status?: number }).status !== 401) console.warn('auth/me failed:', err)
      setUser(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    refresh().finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [refresh])

  const login = useCallback(async (identifiant: string, motDePasse: string) => {
    await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ identifiant, motDePasse }) })
    await refresh()
  }, [refresh])

  const loginPicker = useCallback(async (IDutilisateur: number) => {
    await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ IDutilisateur }) })
    await refresh()
  }, [refresh])

  const enrolerPoste = useCallback(async (code: string, app: AppCode) => {
    await apiFetch('/auth/poste', { method: 'POST', body: JSON.stringify({ code, app }) })
    await refresh()
  }, [refresh])

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch (err) {
      // Best-effort — even if the API call fails, drop back to the login screen.
      console.warn('logout failed:', err)
    }
    setUser(null)
  }, [])

  return (
    <UserContext.Provider value={{ user, isLoading, login, loginPicker, enrolerPoste, logout, refresh }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext)
  if (!ctx) throw new Error('useUser must be used within a UserProvider')
  return ctx
}

/** Whether the session may « Voir comme » another account: its owner is an
 *  admin (true even while looking through someone else). */
export function canSwitchUser(user: CurrentUser | null): boolean {
  return user?.isAdmin === true
}

/** The French error message an auth call failed with. */
export function messageErreur(err: unknown, defaut: string): string {
  return (err as { body?: { message?: string } })?.body?.message ?? defaut
}
