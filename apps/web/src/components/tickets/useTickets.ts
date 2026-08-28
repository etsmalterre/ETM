// Data layer for the ticket widget. Talks only to the same-origin proxy
// (/api/tickets/*) — reporter identity and the tracker API key are injected
// server-side. Uses a local raw fetch instead of apiFetch because the proxy
// returns French error messages (no_reporter_email, not_configured…) that
// must reach the UI verbatim, and apiFetch discards response bodies.
//
// The "my tickets" list itself lives in useTicketNotifications (React Query,
// polled for the unread badge) — this hook owns the write side plus detail
// fetches, and exports the primitives the list query is built on.

import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_URL } from '@/lib/api'
import { useUser } from '@/contexts/UserContext'
import type { Ticket, TicketAttachment, TicketCategory, TicketSeverity, TicketStatus } from './types'

export async function ticketFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const isForm = options?.body instanceof FormData
  const res = await fetch(`${API_URL}/tickets${path}`, {
    ...options,
    credentials: 'include',
    // Never set Content-Type on multipart — the browser adds the boundary.
    headers: isForm
      ? options?.headers
      : { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const message =
      (data && (data.message || data.detail || data.error)) || `Erreur HTTP ${res.status}`
    const err: Error & { status?: number } = new Error(String(message))
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export function mapTicket(raw: Record<string, unknown>): Ticket {
  return {
    id: raw.id as string,
    number: typeof raw.number === 'number' ? raw.number : null,
    title: raw.title as string,
    description: raw.description as string,
    severity: raw.severity as TicketSeverity,
    status: raw.status as TicketStatus,
    category: (raw.category as TicketCategory) || 'bug',
    context: (raw.context as string) || null,
    reporter_email: raw.reporter_email as string,
    reporter_name: raw.reporter_name as string,
    created_at: raw.created_at as string,
    comment: (raw.comment as string) || null,
    follow_up: raw.follow_up === true,
    fixed_in_version: (raw.fixed_in_version as string) || null,
    resolved_at: (raw.resolved_at as string) || null,
    attachments: (raw.attachments as TicketAttachment[]) || [],
  }
}

/** The session user's tickets, newest first. The proxy scopes the list to the
 *  session user's reporter_email — the browser never names it. per_page is
 *  raised to the tracker's max so the closed-tickets drawer and the unread
 *  badge see the whole history rather than the first page. */
export async function listMyTickets(): Promise<Ticket[]> {
  const data = await ticketFetch<{ items?: Record<string, unknown>[] }>('?per_page=100')
  return (data.items || []).map(mapTicket)
}

export interface NewTicket {
  title: string
  description: string
  severity: TicketSeverity
  category: TicketCategory
  context: string | null
  /** Opt-in: email me whenever this ticket's status moves. */
  follow_up: boolean
  /** Who is at the keyboard of a shared station (see reporterHint.ts). The
   *  proxy only honours it for an account without a mapped email. */
  reporter_name: string | null
}

/** Who the session reports as. `can_follow` is false for an account with no
 *  mapped email: its tickets go out under a synthetic identity and the
 *  follow-up mail has nobody to reach, so the widget hides those controls. */
export interface TicketReporter {
  name: string
  can_follow: boolean
}

export async function fetchTicketReporter(): Promise<TicketReporter> {
  const data = await ticketFetch<Partial<TicketReporter>>('/reporter')
  return { name: String(data.name ?? ''), can_follow: data.can_follow !== false }
}

/** One lookup per session, cached for good: an email mapping changes through
 *  the admin screen, and a reload is a fine price for that. */
export function useTicketReporter() {
  const { user } = useUser()
  const userId = user?.IDutilisateur ?? null
  return useQuery({
    queryKey: ['tickets-reporter', userId],
    queryFn: fetchTicketReporter,
    enabled: userId !== null,
    staleTime: Infinity,
    retry: false,
  })
}

export function useTickets() {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const submitTicket = useCallback(async (data: NewTicket): Promise<Ticket> => {
    setIsSubmitting(true)
    try {
      const created = await ticketFetch<Record<string, unknown>>('', {
        method: 'POST',
        body: JSON.stringify({
          title: data.title,
          description: data.description,
          severity: data.severity,
          category: data.category,
          context: data.context || undefined,
          follow_up: data.follow_up,
          reporter_name: data.reporter_name || undefined,
          environment: import.meta.env.DEV ? 'Development' : 'Production',
        }),
      })
      return mapTicket(created)
    } finally {
      setIsSubmitting(false)
    }
  }, [])

  const fetchTicket = useCallback(async (id: string): Promise<Ticket> => {
    const data = await ticketFetch<Record<string, unknown>>(`/${id}`)
    return mapTicket(data)
  }, [])

  /** Turn status-change emails on or off for one ticket. Returns the updated
   *  ticket so the caller can refresh its own copy — the tracker is the source
   *  of truth for the flag, never local state. */
  const setFollowUp = useCallback(async (id: string, follow_up: boolean): Promise<Ticket> => {
    const data = await ticketFetch<Record<string, unknown>>(`/${id}/follow`, {
      method: 'PATCH',
      body: JSON.stringify({ follow_up }),
    })
    return mapTicket(data)
  }, [])

  const uploadAttachments = useCallback(async (ticketId: string, files: File[]): Promise<void> => {
    const formData = new FormData()
    for (const file of files) formData.append('files', file)
    await ticketFetch(`/${ticketId}/attachments`, { method: 'POST', body: formData })
  }, [])

  return {
    isSubmitting,
    submitTicket,
    fetchTicket,
    setFollowUp,
    uploadAttachments,
  }
}
