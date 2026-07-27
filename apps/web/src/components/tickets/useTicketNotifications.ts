// "My tickets" list + unread tracking for the report widget.
//
// The LIVA tracker has no per-user "read" concept, and the MPS database is
// deliberately left untouched (no new HFSQL table / column for this), so read
// state lives entirely in localStorage — keyed per user, because factory PCs
// are shared and a user switch must not inherit someone else's badge.
//
// Each entry stores the last *signature* the user saw for a ticket: the fields
// they actually care about (status, developer reply, fix version, resolution
// date). When the tracker moves any of them the signature changes and the
// ticket counts as unread until its detail is opened. Tracker-side churn the
// user can't see (assignee, internal title) deliberately does NOT notify.
//
// Consequences of being client-side: read state is per browser profile, and
// clearing site data resets it. Both are acceptable for a "you have a reply"
// nudge, and the alternative (a schema change on the shared HFSQL server) is
// not worth it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useUser } from '@/contexts/UserContext'
import { listMyTickets } from './useTickets'
import type { Ticket } from './types'

const STORAGE_PREFIX = 'mps.tickets.seen.'
const POLL_INTERVAL_MS = 5 * 60_000

/** Errors that polling cannot fix: no email mapped to the account (400), no
 *  session (401), tracker not configured on the server (503). Stop the timer
 *  instead of hammering the endpoint every 5 minutes. */
const PERMANENT_STATUSES = [400, 401, 503]

type SeenMap = Record<string, string>

export function myTicketsQueryKey(userId: number | null) {
  return ['my-tickets', userId] as const
}

/** The parts of a ticket a reporter cares about. Any change here = unread. */
export function ticketSignature(t: Ticket): string {
  return [t.status, t.comment ?? '', t.fixed_in_version ?? '', t.resolved_at ?? ''].join('|')
}

// ── localStorage-backed store, shared by every hook instance ──────────────
// The header badge and the modal both call useTicketNotifications, so the seen
// map needs a single source of truth that notifies both on write. getSnapshot
// must be referentially stable between writes, hence the module-level cache.

const listeners = new Set<() => void>()
let cached: { key: string; map: SeenMap } | null = null

function load(key: string): SeenMap | null {
  if (cached && cached.key === key) return cached.map
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    // Storage disabled (private mode, hardened browser) — no persistence,
    // and no badge: load() keeps returning null so nothing reads as unread.
    return null
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as SeenMap
    if (!parsed || typeof parsed !== 'object') return null
    cached = { key, map: parsed }
    return parsed
  } catch {
    return null
  }
}

function save(key: string, map: SeenMap): void {
  cached = { key, map }
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // Quota or disabled storage — keep the in-memory value so the badge
    // behaves for this session even if it won't survive a reload.
  }
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Another tab marking a ticket read should clear the badge here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && !e.key.startsWith(STORAGE_PREFIX)) return
    cached = null
    onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export interface TicketNotifications {
  tickets: Ticket[]
  isLoading: boolean
  listError: string | null
  /** Refetch the list (called when the user lands on "Mes tickets"). */
  refresh: () => void
  unreadCount: number
  isUnread: (t: Ticket) => boolean
  /** Record the ticket as read at its current signature. Also patches the
   *  cached list row so a stale signature can't relight the badge. */
  markSeen: (t: Ticket) => void
  markAllSeen: () => void
}

export function useTicketNotifications(): TicketNotifications {
  const { user } = useUser()
  const queryClient = useQueryClient()
  const userId = user?.IDutilisateur ?? null
  const storageKey = userId === null ? null : `${STORAGE_PREFIX}${userId}`

  const query = useQuery({
    queryKey: myTicketsQueryKey(userId),
    queryFn: listMyTickets,
    enabled: userId !== null,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) => {
      const status = (q.state.error as (Error & { status?: number }) | null)?.status
      if (status !== undefined && PERMANENT_STATUSES.includes(status)) return false
      return POLL_INTERVAL_MS
    },
  })

  const tickets = query.data ?? []

  const seen = useSyncExternalStore(
    subscribe,
    () => (storageKey ? load(storageKey) : null),
    () => null,
  )

  // First run for this user on this browser profile: adopt every current
  // signature so nobody is greeted by a badge counting their whole history.
  useEffect(() => {
    if (!storageKey || seen !== null || !query.isSuccess) return
    const initial: SeenMap = {}
    for (const t of tickets) initial[t.id] = ticketSignature(t)
    save(storageKey, initial)
  }, [storageKey, seen, query.isSuccess, tickets])

  const isUnread = useCallback(
    (t: Ticket) => {
      // Never flash a badge before the store is seeded (see the effect above).
      if (seen === null) return false
      return seen[t.id] !== ticketSignature(t)
    },
    [seen],
  )

  const unreadCount = useMemo(() => tickets.filter(isUnread).length, [tickets, isUnread])

  const markSeen = useCallback(
    (t: Ticket) => {
      if (!storageKey) return
      // The detail endpoint can return a fresher ticket than the cached list
      // row; write it back so isUnread compares against what was displayed.
      queryClient.setQueryData<Ticket[]>(myTicketsQueryKey(userId), (old) =>
        old ? old.map((row) => (row.id === t.id ? t : row)) : old,
      )
      const current = load(storageKey) ?? {}
      const sig = ticketSignature(t)
      if (current[t.id] === sig) return
      save(storageKey, { ...current, [t.id]: sig })
    },
    [storageKey, queryClient, userId],
  )

  const markAllSeen = useCallback(() => {
    if (!storageKey) return
    const next: SeenMap = { ...(load(storageKey) ?? {}) }
    for (const t of tickets) next[t.id] = ticketSignature(t)
    save(storageKey, next)
  }, [storageKey, tickets])

  const refresh = useCallback(() => {
    void query.refetch()
  }, [query.refetch])

  return {
    tickets,
    isLoading: query.isLoading,
    listError: query.error ? (query.error as Error).message : null,
    refresh,
    unreadCount,
    isUnread,
    markSeen,
    markAllSeen,
  }
}
