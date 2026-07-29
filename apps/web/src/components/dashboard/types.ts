// Shared types for the customisable tableau de bord.
//
// Layout model: every widget has a real GRID POSITION — `x` (column, 0-11) and
// `y` (row units) — plus a size (`width` in columns, `heightPx` in pixels).
// react-grid-layout renders and edits the desktop grid with vertical
// compaction ("gravity"): widgets fall upward into free space, so a short
// widget leaves room beneath it in its own column and another widget can be
// dropped exactly there. Below `lg` the grid is bypassed entirely — one
// column, ordered by (y, x), definite heights.

export type DashboardWidth = number

/** A user's dashboards are named tabs, surfaced as the submenu of "Tableau de
 *  bord". The first one always exists, is routed at `/`, and cannot be deleted;
 *  the others live at `/tableau-de-bord/<id>`. Mirrors the API's
 *  lib/user-profiles.ts constants — keep both in step. */
export const DASHBOARD_PRIMARY_ID = 'principal'
export const DASHBOARD_PRIMARY_NAME = 'Principal'
export const DASHBOARD_MAX_TABS = 8
export const DASHBOARD_MAX_NAME_LENGTH = 40

export interface DashboardTab {
  id: string
  name: string
  /** null = "follow the registry defaults" — only ever set on the primary. */
  layout: DashboardWidgetPref[] | null
}

/** Route of a dashboard tab. The primary keeps `/` so existing links, the
 *  sidebar entry and the PWA start URL all still land somewhere real. */
export function dashboardHref(id: string, index: number): string {
  return index === 0 || id === DASHBOARD_PRIMARY_ID ? '/' : `/tableau-de-bord/${id}`
}

export const GRID_COLUMNS = 12
/** Gutter between widgets (react-grid-layout `margin`). */
export const GRID_MARGIN_PX = 16
/** Row quantum (react-grid-layout `rowHeight`). An item spanning h units is
 *  `h*ROW + (h-1)*MARGIN` px tall, so heights snap to 24px steps. */
export const GRID_ROW_HEIGHT_PX = 8
/** Floor for a dragged height; below this a widget's header alone won't fit. */
export const MIN_WIDGET_HEIGHT_PX = 200

/** One widget's stored preference. Hidden widgets keep their entry (size and
 *  position) so re-showing one restores what the user had. `x`/`y` absent on
 *  layouts saved before the positional model — resolveDraft backfills them. */
export interface DashboardWidgetPref {
  key: string
  width: DashboardWidth
  heightPx: number
  x?: number
  y?: number
  visible: boolean
}

export function clampWidth(width: number, minWidth: number): DashboardWidth {
  if (!Number.isFinite(width)) return minWidth
  return Math.min(GRID_COLUMNS, Math.max(minWidth, Math.round(width)))
}

/** px → row units (inverse of unitsToHeight, rounded to the 24px quantum). */
export function heightToUnits(px: number): number {
  return Math.max(1, Math.round((px + GRID_MARGIN_PX) / (GRID_ROW_HEIGHT_PX + GRID_MARGIN_PX)))
}

/** Row units → the pixel height react-grid-layout actually renders. */
export function unitsToHeight(h: number): number {
  return h * GRID_ROW_HEIGHT_PX + (h - 1) * GRID_MARGIN_PX
}

/** Minimum height in row units (≙ MIN_WIDGET_HEIGHT_PX). */
export const MIN_WIDGET_HEIGHT_UNITS = heightToUnits(MIN_WIDGET_HEIGHT_PX)
