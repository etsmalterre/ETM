// Catalog of every tableau de bord widget.
//
// Adding a widget = one entry here. The dashboard derives everything else from
// it: which users may see it (`permission`), how it appears in the hidden-widget
// tray (`title` / `icon`), what sizes it offers, and where it lands by default.
//
// `key` is persisted in each user's saved layout, so treat it as stable —
// renaming one silently drops that widget from every layout that mentions it
// (it degrades gracefully: the widget reappears at the end with its defaults).

import { TrendingUp, FileSpreadsheet, LineChart, ShoppingCart, Wallet } from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { TricobotMascot } from '@/components/icons/TricobotMascot'
import { AnalyseFinanciereWidget } from './AnalyseFinanciereWidget'
import { ChiffreAffairesWidget } from './ChiffreAffairesWidget'
import { FilStockEtatWidget } from './FilStockEtatWidget'
import { LaGentleExportWidget } from './LaGentleExportWidget'
import { NotificationsWidget } from './NotificationsWidget'
import { UtilisationFilWidget } from './UtilisationFilWidget'
import { SuiviPieceWidget } from './SuiviPieceWidget'
import { CommandesDuJourWidget } from './CommandesDuJourWidget'
import { ChargesWidget } from './ChargesWidget'
import { EvolutionCaWidget } from './EvolutionCaWidget'
import type { DashboardApp, WidgetDef } from './types'

export type { WidgetDef }

/** This registry describes ETM's dashboards. The TRM app has its own
 *  registry.tsx (same exports, `'trm'`) — the shared Dashboard screen and
 *  layout hook reach whichever one `@/components/dashboard/registry` resolves
 *  to in the app being built. */
export const DASHBOARD_APP: DashboardApp = 'etm'

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
    key: 'evolution_ca',
    // Sub-right of dashboard_ca. The endpoint still enforces the parent, so the
    // figure stays protected; this key only decides whether the chart shows, so
    // an admin can grant the CA table without the chart or the reverse. A child
    // is never held without its parent, so the widget can't render onto a 403.
    permission: 'dashboard_evolution_ca',
    title: 'Évolution du CA',
    icon: TrendingUp,
    defaultWidth: 6,
    // Twelve month labels need the width; below 4 columns they collide.
    minWidth: 4,
    defaultHeightPx: 460,
    Component: EvolutionCaWidget,
  },
  {
    key: 'finance_analyse',
    permission: 'dashboard_finance',
    title: 'Analyse financière',
    icon: LineChart,
    defaultWidth: 6,
    // Below ~4 columns the 12 month labels and the € axis start colliding.
    minWidth: 4,
    defaultHeightPx: 460,
    Component: AnalyseFinanciereWidget,
  },
  // ⚠️ « Valorisation du stock » a été RETIRÉ du tableau de bord le 2026-08-26,
  // sans rien supprimer d'autre. Il répondait à « combien vaut mon stock » — une
  // question de bilan, à cadence annuelle — et affichait un taux de provision
  // sans point de comparaison, donc ininterprétable au quotidien (décision
  // Vincent : « j'attends que le besoin s'exprime vraiment »).
  //
  // Le remettre = RÉTABLIR CETTE SEULE ENTRÉE. Tout le reste est intact et
  // testé : `ValorisationStockWidget.tsx`, l'endpoint
  // `GET /rapports/stock/valorisation`, la permission `dashboard_stock_valorisation`
  // et le guard `check-valorisation-stock.ts`.
  //
  // ⚠️ Et surtout : `apps/api/src/lib/valorisation-stock.ts` N'EST PAS DU CODE
  // MORT. `variation-stock.ts` l'appelle (`valoriserStockCache()`) pour estimer
  // la variation de stock injectée dans l'EBE de l'Analyse financière et du
  // rapport Finance. Le supprimer casserait ces deux écrans en silence.
  //
  // Si le besoin revient, la piste chiffrée est la « falaise » plutôt que le
  // niveau : `valoriserStock(asOf)` accepte une date et vieillit le stock
  // courant, donc « à périmètre constant » se calcule sans requête nouvelle —
  // mesuré au 26/08/2026 : −108 597 € de valeur nette à 6 mois, −182 103 € à
  // 12 mois si rien ne bouge. Ça, c'est une liste de priorités de vente.
  {
    key: 'commandes_jour',
    permission: 'dashboard_commandes_jour',
    title: 'Commandes du jour',
    icon: ShoppingCart,
    defaultWidth: 6,
    // The CA figure and the order count share the top band; below 3 columns
    // they stop fitting on one row.
    minWidth: 3,
    defaultHeightPx: 460,
    Component: CommandesDuJourWidget,
  },
  {
    key: 'charges',
    // Sub-right of view_rapport_finance rather than a standalone key: the widget
    // shares GET /rapports/finance with the report screen, so the endpoint keeps
    // enforcing the parent (adding a child check there would 403 the report for
    // everyone holding only the parent). Being a child means it can't be granted
    // on its own, so the widget never shows against data that would 403.
    permission: 'dashboard_charges',
    title: 'Charges',
    icon: Wallet,
    defaultWidth: 4,
    // Two stacked amount blocks — they hold up narrow.
    minWidth: 3,
    defaultHeightPx: 340,
    Component: ChargesWidget,
  },
  {
    key: 'notifications',
    permission: 'dashboard_notifications',
    title: 'Notifications',
    // Tricobot, not a bell — he's who the alerts come from, and the tray chip
    // should be recognisable as the same thing the widget header shows.
    icon: TricobotMascot,
    defaultWidth: 6,
    // The cards are a two-line title/description stack, so they survive being
    // narrow; below 3 columns the type filter and the count stop sharing a row.
    minWidth: 3,
    defaultHeightPx: 500,
    Component: NotificationsWidget,
  },
  {
    key: 'utilisation_fil',
    permission: 'dashboard_utilisation_fil',
    title: 'Utilisation fil',
    icon: BobineIcon,
    defaultWidth: 6,
    // Two stacked pickers with a label column, then a list — below 3 columns
    // the combobox and its label stop sharing a row.
    minWidth: 3,
    defaultHeightPx: 500,
    Component: UtilisationFilWidget,
  },
  {
    key: 'suivi_piece',
    permission: 'dashboard_suivi_piece',
    title: 'Suivi pièce',
    icon: TmRollIcon,
    defaultWidth: 6,
    // The timeline cards are label/value pairs in a 2-column grid — they hold
    // up narrow; the search row is what needs the width.
    minWidth: 3,
    defaultHeightPx: 520,
    Component: SuiviPieceWidget,
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
