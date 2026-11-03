// Shared API fetch helper — every call sends the tablet's cookie
// (`credentials: 'include'`) to the MPS API (apps/api in this repo).

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'

/** What a failed call throws: the status, plus the API's machine-readable
 *  `error` code and French `message` when the body carried them
 *  (lib/erreurs.ts turns them into a sentence). */
export interface ApiError extends Error {
  status?: number
  code?: string
  detail?: string
}

export async function apiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const err: ApiError = new Error(`API ${res.status}`)
    err.status = res.status
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown }
      if (typeof body?.error === 'string') err.code = body.error
      if (typeof body?.message === 'string') err.detail = body.message
    } catch {
      // No JSON body — the status is all we know.
    }
    throw err
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
