// ETM API client, used by the background worker and the side panel. Extension
// contexts call the API thanks to host_permissions (no CORS); the session is
// the extension's own, carried as a bearer — never the browser's ETM cookie.

import { getSession, getSettings, setSession, type Session } from './config'
import type { Conversation, GmailContext, MessageFil } from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const { apiUrl } = await getSettings()
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (auth) {
    const session = await getSession()
    if (!session) throw new ApiError('Connexion requise', 401)
    headers.set('Authorization', `Bearer ${session.token}`)
  }

  let res: Response
  try {
    res = await fetch(`${apiUrl}${path}`, { ...init, headers, credentials: 'omit' })
  } catch {
    throw new ApiError(`ETM injoignable (${apiUrl})`, 0)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    // Expired or revoked session: drop it so the panel shows the login form.
    if (res.status === 401 && auth) await setSession(null)
    const b = body as { message?: string; error?: string } | null
    throw new ApiError(b?.message ?? b?.error ?? `Erreur ${res.status}`, res.status)
  }
  return body as T
}

export async function login(identifiant: string, motDePasse: string): Promise<Session> {
  const data = await request<{ jeton?: string; identifiant: string | null; email: string | null; prenom: string | null }>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ identifiant, motDePasse, client: 'extension' }) },
    false,
  )
  // An ETM older than the extension logs in with a cookie and returns no token.
  if (!data.jeton) throw new ApiError(TROP_ANCIEN, 404)
  const session = { token: data.jeton, identifiant: data.identifiant ?? data.email ?? identifiant, prenom: data.prenom }
  await setSession(session)
  return session
}

/** Revokes the extension's session on the server, then forgets it. */
export async function logout(): Promise<void> {
  await request('/auth/logout', { method: 'POST' }).catch(() => {})
  await setSession(null)
}

const TROP_ANCIEN = 'Cet ETM ne connaît pas encore l’extension Tricobot : vérifiez l’URL de l’API (⚙).'

export function fetchConversation(ctx: GmailContext): Promise<Conversation> {
  const params = new URLSearchParams()
  if (ctx.mailbox) params.set('boite', ctx.mailbox)
  if (ctx.threadId) params.set('thread', ctx.threadId)
  if (ctx.messageIds.length > 0) params.set('messages', ctx.messageIds.join(','))
  return request<Conversation>(`/tricobot/conversation?${params}`).catch((e: unknown) => {
    throw e instanceof ApiError && e.status === 404 ? new ApiError(TROP_ANCIEN, 404) : e
  })
}

/** A correction / score on an existing ETM route (paths come from the conversation). */
export function send(method: 'PUT' | 'POST', path: string, body: Record<string, unknown>): Promise<unknown> {
  return request(path, { method, body: JSON.stringify(body) })
}

export function fetchFil(boite: string, threadId: string): Promise<{ messages: MessageFil[] }> {
  return request(`/tricobot/fil?${new URLSearchParams({ boite, thread: threadId })}`)
}

/** Downloads one attachment (bearer auth, so no plain link) and opens it in a tab. */
export async function ouvrirPieceJointe(boite: string, threadId: string, messageId: string, n: number): Promise<void> {
  const [{ apiUrl }, session] = await Promise.all([getSettings(), getSession()])
  if (!session) throw new ApiError('Connexion requise', 401)
  const url = `${apiUrl}/tricobot/fil/${threadId}/messages/${messageId}/pieces/${n}?${new URLSearchParams({ boite })}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` }, credentials: 'omit' })
  if (!res.ok) throw new ApiError(`Pièce jointe indisponible (${res.status})`, res.status)
  const blob = await res.blob()
  window.open(URL.createObjectURL(blob), '_blank')
}
