// Catalog of every tableau de bord widget.
//
// Adding a widget = one entry here. The dashboard derives everything else from
// it: which users may see it (`permission`), how it appears in the hidden-widget
// tray (`title` / `icon`), what sizes it offers, and where it lands by default.
//
// `key` is persisted in each user's saved layout, so treat it as stable —
// renaming one silently drops that widget from every layout that mentions it
// (it degrades gracefully: the widget reappears at the end with its defaults).

import type { ComponentType } from 'react'
import { TrendingUp, FileSpreadsheet } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { ChiffreAffairesWidget } from './ChiffreAffairesWidget'
import { FilStockEtatWidget } from './FilStockEtatWidget'
import { LaGentleExportWidget } from './LaGentleExportWidget'
import type { DashboardWidth } from './types'

export interface WidgetDef {
  key: string
  /** Permission key gating this widget. Users without it never see the widget,
   *  nor its entry in the hidden-widget tray. */
  permission: string
  /** Shown in the tray and in the reset confirmation — the widget renders its
   *  own title inside its frame. */
  title: string
  icon: ComponentType<{ className?: string }>
  defaultWidth: DashboardWidth
  /** Narrowest the user may drag this widget, in grid columns. Set it from the
   *  content: a widget with a 5-column table can't live at 3 columns. */
  minWidth: number
  /** Starting card height in pixels. Every widget needs one: the grid packs
   *  widgets by row units, so a short widget leaves room a later one can drop
   *  into — which only works if heights are known rather than content-driven.
   *  The user overrides it by dragging the bottom edge. */
  defaultHeightPx: number
  Component: ComponentType
}

/** Order here is the out-of-the-box dashboard for a user who never customised. */
export const WIDGET_REGISTRY: readonly WidgetDef[] = [
  {
    key: 'chiffre_affaires',
    permission: 'dashboard_ca',
    title: "Chiffre d'affaires",
    icon: TrendingUp,
    defaultWidth: 12,
    // Narrow is the user's call: the ranking's € columns stop fitting well
    // below ~6 columns, but the table scrolls horizontally rather than break,
    // so there's no reason to forbid it.
    minWidth: 3,
    defaultHeightPx: 720,
    Component: ChiffreAffairesWidget,
  },
  {
    key: 'fil_etat',
    permission: 'dashboard_fil_etat',
    title: 'État des stocks de fil',
    icon: BobineIcon,
    defaultWidth: 6,
    minWidth: 3,
    defaultHeightPx: 500,
    Component: FilStockEtatWidget,
  },
  {
    key: 'la_gentle',
    permission: 'dashboard_la_gentle',
    title: 'Stock La Gentle',
    icon: FileSpreadsheet,
    defaultWidth: 6,
    minWidth: 3,
    defaultHeightPx: 430,
    Component: LaGentleExportWidget,
  },
]

export function findWidget(key: string): WidgetDef | undefined {
  return WIDGET_REGISTRY.find((w) => w.key === key)
}
