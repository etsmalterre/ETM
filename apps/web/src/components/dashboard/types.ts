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
