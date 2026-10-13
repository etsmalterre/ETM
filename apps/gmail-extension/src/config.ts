// Extension settings + session, kept in chrome.storage.local.

// Same entry point as the ERP (Caddy → nginx → API): HTTPS, public certificate,
// reachable wherever ETM is (LAN and Tailscale).
export const DEFAULT_API_URL = 'https://etm.intra.etsmalterre.com/api'
export const DEFAULT_ERP_URL = 'https://etm.intra.etsmalterre.com'

export interface Settings {
  apiUrl: string
  erpUrl: string
}

export interface Session {
  /** ETM session token, sent as a bearer (apps/api lib/auth.ts jetonBearer). */
  token: string
  identifiant: string
  prenom: string | null
}

export async function getSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['apiUrl', 'erpUrl'])
  return {
    apiUrl: (s.apiUrl as string | undefined) || DEFAULT_API_URL,
    erpUrl: (s.erpUrl as string | undefined) || DEFAULT_ERP_URL,
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({
    apiUrl: settings.apiUrl.trim().replace(/\/+$/, ''),
    erpUrl: settings.erpUrl.trim().replace(/\/+$/, ''),
  })
}

export async function getSession(): Promise<Session | null> {
  const { session } = await chrome.storage.local.get('session')
  return (session as Session | undefined) ?? null
}

export async function setSession(session: Session | null): Promise<void> {
  if (session) await chrome.storage.local.set({ session })
  else await chrome.storage.local.remove('session')
}

// The Gmail context of each tab, written by the background worker and read
// by the side panel (storage.session is not visible to content scripts).
export const contextKey = (tabId: number): string => `ctx:${tabId}`
