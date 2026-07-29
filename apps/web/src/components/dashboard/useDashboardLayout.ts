// Resolves a user's saved tableau de bord layouts against the widget registry
// and their permissions, and persists changes.
//
// A user has one or more NAMED dashboards (the submenu tabs of "Tableau de
// bord"). The first is the primary: always present, routed at `/`, and the one
// that follows the registry defaults. The others are created by the user and
// start EMPTY — every widget in the tray — because splitting widgets across
// screens is the whole point of having more than one.
//
// Merge rules — these are what make the feature safe over time:
//   • A widget the user can't see (permission revoked, or never granted) is
//     filtered out entirely, but its saved entry is kept on disk so re-granting
//     restores the size and position they had chosen.
//   • A widget in the registry that the saved layout doesn't mention — newly
//     built, or newly granted — is appended VISIBLE on the primary dashboard,
//     so a stale layout can never hide a widget an admin just granted, and
//     HIDDEN on the others, so a new widget never gate-crashes a dashboard the
//     user curated.
//   • A saved key with no registry entry (widget retired or renamed) is
//     dropped from the resolved layout and from the next save.
//   • A saved entry with no x/y (pre-positional layouts) is shelf-packed in
//     saved order, reproducing the old flow layout closely enough.
//
// Positions are normalised through the same vertical compaction the grid
// applies, so loading a layout doesn't immediately mark it dirty.

import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { usePermissions } from '@/contexts/PermissionsContext'
import { WIDGET_REGISTRY, type WidgetDef } from './registry'
import {
  DASHBOARD_MAX_TABS,
  DASHBOARD_PRIMARY_ID,
  DASHBOARD_PRIMARY_NAME,
  GRID_COLUMNS,
  MIN_WIDGET_HEIGHT_PX,
  clampWidth,
  heightToUnits,
  type DashboardTab,
  type DashboardWidgetPref,
  type DashboardWidth,
} from './types'

/** Editable working copy. Sizes AND positions are always concrete after
 *  resolve — the positional grid can't place a widget without them. */
export interface DraftLayout {
  visible: string[]
  hidden: string[]
  sizes: Record<string, { width: DashboardWidth; heightPx: number; x: number; y: number }>
}

interface DashboardResponse {
  dashboards: DashboardTab[]
}

const QUERY_KEY = ['dashboard-layout'] as const

interface Box { key: string; x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Vertical compaction — same behaviour as react-grid-layout's: scanning by
 *  (y, x), each item rises as far as it can, then settles below whatever it
 *  still collides with. Mutates `boxes`. */
function compactVertical(boxes: Box[]): void {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: Box[] = []
  for (const it of sorted) {
    let y = it.y
    const collidesAt = (cy: number) =>
      placed.find((p) => overlaps({ ...it, y: cy }, p))
    while (y > 0 && !collidesAt(y - 1)) y--
    let hit = collidesAt(y)
    while (hit) { y = hit.y + hit.h; hit = collidesAt(y) }
    it.y = y
    placed.push(it)
  }
}

/** Left-to-right shelf packing for entries with no stored position — used for
 *  registry defaults and for layouts saved before the positional model. */
function shelfPack(
  items: { key: string; w: number; h: number }[],
  startY: number,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  let x = 0
  let y = startY
  let rowH = 0
  for (const it of items) {
    if (x + it.w > GRID_COLUMNS) { x = 0; y += rowH; rowH = 0 }
    out.set(it.key, { x, y })
    x += it.w
    rowH = Math.max(rowH, it.h)
  }
  return out
}

/** Registry defaults, used before anything is saved and by "Réinitialiser". */
export function defaultDraft(available: readonly WidgetDef[]): DraftLayout {
  const packed = shelfPack(
    available.map((w) => ({ key: w.key, w: w.defaultWidth, h: heightToUnits(w.defaultHeightPx) })),
    0,
  )
  const sizes: DraftLayout['sizes'] = {}
  for (const w of available) {
    const pos = packed.get(w.key) ?? { x: 0, y: 0 }
    sizes[w.key] = { width: w.defaultWidth, heightPx: w.defaultHeightPx, ...pos }
  }
  return { visible: available.map((w) => w.key), hidden: [], sizes }
}

/** Every widget hidden — what a freshly created dashboard looks like. */
export function emptyDraft(available: readonly WidgetDef[]): DraftLayout {
  const sizes: DraftLayout['sizes'] = {}
  for (const w of available) {
    sizes[w.key] = { width: w.defaultWidth, heightPx: w.defaultHeightPx, x: 0, y: 0 }
  }
  return { visible: [], hidden: available.map((w) => w.key), sizes }
}

/** Merge a saved layout with the widgets this user can actually see.
 *
 *  `isPrimary` decides what happens to a widget the layout never mentions:
 *  shown on the primary dashboard (a stale layout must not hide a newly granted
 *  widget), hidden on the others (they hold what the user put there). It is
 *  also what separates "no layout at all" — the primary's defaults — from a
 *  secondary dashboard the user emptied on purpose. */
export function resolveDraft(
  saved: DashboardWidgetPref[] | null,
  available: readonly WidgetDef[],
  isPrimary = true,
): DraftLayout {
  if (!saved || saved.length === 0) {
    return isPrimary ? defaultDraft(available) : emptyDraft(available)
  }

  const byKey = new Map(available.map((w) => [w.key, w]))
  const draft: DraftLayout = { visible: [], hidden: [], sizes: {} }
  const seen = new Set<string>()
  const unpositioned: { key: string; w: number; h: number }[] = []

  for (const pref of saved) {
    const def = byKey.get(pref.key)
    if (!def || seen.has(pref.key)) continue // unknown/retired widget, or dupe
    seen.add(pref.key)
    const width = clampWidth(pref.width, def.minWidth)
    const heightPx = typeof pref.heightPx === 'number' && Number.isFinite(pref.heightPx)
      ? Math.max(MIN_WIDGET_HEIGHT_PX, Math.round(pref.heightPx))
      : def.defaultHeightPx
    const hasPos = Number.isInteger(pref.x) && Number.isInteger(pref.y)
    const x = hasPos ? Math.min(GRID_COLUMNS - width, Math.max(0, pref.x as number)) : 0
    const y = hasPos ? Math.max(0, pref.y as number) : 0
    draft.sizes[pref.key] = { width, heightPx, x, y }
    if (!hasPos && pref.visible) {
      unpositioned.push({ key: pref.key, w: width, h: heightToUnits(heightPx) })
    }
    ;(pref.visible ? draft.visible : draft.hidden).push(pref.key)
  }

  // Anything the saved layout never mentioned is new to this user → show it at
  // the bottom of the grid (compaction will snug it up) on the primary
  // dashboard; park it in the tray on the others.
  for (const def of available) {
    if (seen.has(def.key)) continue
    draft.sizes[def.key] = { width: def.defaultWidth, heightPx: def.defaultHeightPx, x: 0, y: 0 }
    if (!isPrimary) { draft.hidden.push(def.key); continue }
    unpositioned.push({ key: def.key, w: def.defaultWidth, h: heightToUnits(def.defaultHeightPx) })
    draft.visible.push(def.key)
  }

  // Backfill positions for anything that lacked one, below what IS positioned.
  if (unpositioned.length > 0) {
    const positioned = draft.visible.filter((k) => !unpositioned.some((u) => u.key === k))
    const maxY = positioned.reduce((m, k) => {
      const s = draft.sizes[k]
      return Math.max(m, s.y + heightToUnits(s.heightPx))
    }, 0)
    const packed = shelfPack(unpositioned, maxY)
    for (const [key, pos] of packed) draft.sizes[key] = { ...draft.sizes[key], ...pos }
  }

  // Normalise through the grid's own gravity so loading isn't already "dirty".
  const boxes: Box[] = draft.visible.map((k) => {
    const s = draft.sizes[k]
    return { key: k, x: s.x, y: s.y, w: s.width, h: heightToUnits(s.heightPx) }
  })
  compactVertical(boxes)
  for (const b of boxes) draft.sizes[b.key] = { ...draft.sizes[b.key], x: b.x, y: b.y }

  return draft
}

/** Serialize a draft back to the stored shape. Visible widgets are ordered by
 *  (y, x) — canonical, so compaction-equivalent layouts share a signature. */
export function draftToPrefs(draft: DraftLayout): DashboardWidgetPref[] {
  const entry = (key: string, visible: boolean): DashboardWidgetPref => {
    const s = draft.sizes[key]
    return { key, width: s?.width ?? 6, heightPx: s?.heightPx ?? 400, x: s?.x ?? 0, y: s?.y ?? 0, visible }
  }
  const visibleSorted = [...draft.visible].sort((a, b) => {
    const sa = draft.sizes[a]; const sb = draft.sizes[b]
    return (sa?.y ?? 0) - (sb?.y ?? 0) || (sa?.x ?? 0) - (sb?.x ?? 0) || a.localeCompare(b)
  })
  return [
    ...visibleSorted.map((k) => entry(k, true)),
    ...draft.hidden.map((k) => entry(k, false)),
  ]
}

/** Stable string used to detect unsaved changes. */
export function draftSignature(draft: DraftLayout): string {
  return JSON.stringify(draftToPrefs(draft))
}

/** The dashboards list every nav surface reads. Shares its cache entry with
 *  `useDashboardLayout`, so the header tabs update the moment one is created,
 *  renamed or deleted. */
export function useDashboardTabs() {
  const query = useQuery<DashboardResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch('/user-profiles/me/dashboard'),
    staleTime: 5 * 60_000,
  })
  return {
    tabs: query.data?.dashboards ?? [],
    isLoading: query.isLoading,
  }
}

/** Ids for user-created dashboards. Random rather than derived from the name,
 *  so renaming one never changes its URL (or orphans a bookmark). */
function newTabId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function useDashboardLayout(activeId: string) {
  const queryClient = useQueryClient()
  const { has, isLoading: permsLoading } = usePermissions()

  // Widgets this user is allowed to see, in registry order.
  const available = useMemo(
    () => WIDGET_REGISTRY.filter((w) => has(w.permission)),
    [has],
  )

  const query = useQuery<DashboardResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch('/user-profiles/me/dashboard'),
    staleTime: 5 * 60_000,
  })

  const tabs = useMemo<DashboardTab[]>(
    () => query.data?.dashboards ?? [],
    [query.data],
  )
  // An unknown id (deleted dashboard, stale bookmark) falls back to the primary
  // rather than rendering nothing — the caller redirects the URL.
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === activeId))
  const active = tabs[activeIndex] ?? null
  const isPrimary = activeIndex === 0
  const activeExists = tabs.some((t) => t.id === activeId)

  const saved = useMemo(
    () => resolveDraft(active?.layout ?? null, available, isPrimary),
    [active, available, isPrimary],
  )

  const saveMutation = useMutation({
    mutationFn: (dashboards: DashboardTab[]) =>
      apiFetch<DashboardResponse>('/user-profiles/me/dashboard', {
        method: 'PUT',
        body: JSON.stringify({ dashboards }),
      }),
    onSuccess: (data) => queryClient.setQueryData(QUERY_KEY, data),
  })

  /** Current tabs with the active one's layout replaced by `draft`.
   *
   *  On the primary, a draft matching the registry defaults is stored as `null`
   *  — "I have no opinion, follow the defaults" — rather than as a frozen copy
   *  of today's defaults, so a user who hits Réinitialiser keeps tracking future
   *  changes to the default dashboard. A secondary dashboard always stores its
   *  array: there, empty means "I emptied it", not "give me the defaults". */
  const tabsWithDraft = useCallback(
    (draft: DraftLayout): DashboardTab[] => {
      const isDefault = isPrimary
        && draftSignature(draft) === draftSignature(defaultDraft(available))
      const layout = isDefault ? null : draftToPrefs(draft)
      const base = tabs.length > 0
        ? tabs
        : [{ id: DASHBOARD_PRIMARY_ID, name: DASHBOARD_PRIMARY_NAME, layout: null }]
      return base.map((t, i) => (i === activeIndex ? { ...t, layout } : t))
    },
    [tabs, activeIndex, isPrimary, available],
  )

  const save = useCallback(
    async (draft: DraftLayout) => { await saveMutation.mutateAsync(tabsWithDraft(draft)) },
    [saveMutation, tabsWithDraft],
  )

  /** Add a dashboard and return its id. Any in-progress draft on the current
   *  dashboard is written in the same request — the alternative is silently
   *  dropping it while the user's attention is on the new tab. */
  const createTab = useCallback(
    async (name: string, draft: DraftLayout | null): Promise<string | null> => {
      if (tabs.length >= DASHBOARD_MAX_TABS) return null
      const id = newTabId()
      const base = draft ? tabsWithDraft(draft) : tabs
      await saveMutation.mutateAsync([...base, { id, name, layout: [] }])
      return id
    },
    [tabs, tabsWithDraft, saveMutation],
  )

  const renameTab = useCallback(
    async (id: string, name: string) => {
      await saveMutation.mutateAsync(tabs.map((t) => (t.id === id ? { ...t, name } : t)))
    },
    [tabs, saveMutation],
  )

  /** Delete a dashboard. The primary one is never deletable — it is the route
   *  at `/` and the fallback for every unknown id. */
  const deleteTab = useCallback(
    async (id: string) => {
      if (id === tabs[0]?.id) return
      await saveMutation.mutateAsync(tabs.filter((t) => t.id !== id))
    },
    [tabs, saveMutation],
  )

  return {
    available,
    tabs,
    active,
    activeIndex,
    activeExists,
    isPrimary,
    canCreate: tabs.length < DASHBOARD_MAX_TABS,
    saved,
    isLoading: permsLoading || query.isLoading,
    isSaving: saveMutation.isPending,
    save,
    createTab,
    renameTab,
    deleteTab,
  }
}
