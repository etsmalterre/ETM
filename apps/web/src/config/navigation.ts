import type { ComponentType } from 'react'
import {
  LayoutDashboard,
  Users,
  Building2,
  Truck,
  UserPlus,
  Box,
  ShieldCheck,
  FileBarChart,
  Globe,
  Settings,
} from 'lucide-react'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'

/** Sidebar / mobile-nav only ever pass `className` to the icon, so the
 *  type is intentionally minimal — that lets both SVG-style components
 *  (lucide icons, BobineIcon) and our CSS-masked span icons (TmRollIcon,
 *  FiniRollIcon) plug in without prop-shape gymnastics. */
export type NavIcon = ComponentType<{ className?: string }>

export interface SubMenuItem {
  title: string
  href: string
  /** When true, the entry is only shown to admin users (Vincent Malterre).
   *  Filtered out of the sidebar render when !user.isAdmin. The page itself
   *  also enforces the same check, so direct URL access is blocked. */
  adminOnly?: boolean
  /** When set, the entry is only shown to users holding this permission key.
   *  Filtered out of every nav surface via `visibleSubmenus`. The page and the
   *  API enforce the same check, so hiding it here is convenience, not the
   *  security boundary. */
  permission?: string
}

// ── Screen access ───────────────────────────────────────
// Two levels, mirrored in apps/api/src/lib/screen-keys.ts (kept in sync by
// apps/api/src/scripts/check-screen-access.ts):
//
//   • a MENU is a grant, default closed        — `screen_<menu>`
//   • a SCREEN inside a granted menu is a hide — `hide_<menu>_<screen>`
//
// Granting a menu grants every screen under it, so a newly shipped screen is
// immediately visible to everyone who already has its menu instead of being
// invisible until an admin ticks it per user. Confidentiality is NOT this
// axis's job — that's what an action key like `view_rapport_finance` is for,
// enforced server-side.
//
// Keys derive from the href, so nothing here has to be maintained by hand.

/** '/sous-traitants/commandes' → 'sous_traitants_commandes' */
function slug(href: string): string {
  return href.replace(/^\//, '').replace(/[/-]/g, '_')
}

/** Grant key for a whole menu. Absent = the menu does not exist for the user. */
export function menuAccessKey(menuHref: string): string {
  return `screen_${slug(menuHref)}`
}

/** Hide key for one screen inside a granted menu. Absent = visible. */
export function screenHideKey(screenHref: string): string {
  return `hide_${slug(screenHref)}`
}

/** What every nav-filtering helper needs from the permissions context.
 *
 *  `has` applies the effective-admin bypass; `hasRaw` does NOT. Hide keys MUST
 *  be read through `hasRaw` — with the bypass, `has('hide_fils')` is true for
 *  an admin and would hide every screen from them. */
export interface NavAccess {
  isEffectiveAdmin: boolean
  has: (key: string) => boolean
  hasRaw: (key: string) => boolean
}

/** Filter a submenu list for the current viewer. Used by every nav surface
 *  (sidebar context menu, header tabs, mobile nav) so an entry the user
 *  cannot open never appears in one of them and not the others.
 *
 *  The menu-level grant is NOT checked here (a submenu list doesn't know its
 *  parent) — go through `visibleMainNavigation` / `canOpenScreen` for that. */
export function visibleSubmenus(submenus: SubMenuItem[], opts: NavAccess): SubMenuItem[] {
  return submenus.filter((s) => {
    if (s.adminOnly && !opts.isEffectiveAdmin) return false
    if (s.permission && !opts.has(s.permission)) return false
    if (opts.hasRaw(screenHideKey(s.href))) return false
    return true
  })
}

/** True when the user holds the menu's grant. */
export function canOpenMenu(menuHref: string, opts: NavAccess): boolean {
  return opts.has(menuAccessKey(menuHref))
}

/** The main navigation as this viewer sees it: menus they hold the grant for,
 *  each carrying only the submenus they may open, and menus left with no
 *  submenu at all dropped entirely (same rule the Paramètres menu already
 *  follows when its only entry is admin-only). */
export function visibleMainNavigation(opts: NavAccess): MainMenuItem[] {
  const out: MainMenuItem[] = []
  for (const item of mainNavigation) {
    if (!canOpenMenu(item.href, opts)) continue
    const submenus = visibleSubmenus(item.submenus, opts)
    if (submenus.length === 0) continue
    out.push({ ...item, submenus })
  }
  return out
}

/** Route of the first screen the viewer may open under a menu, or null. Used
 *  for the menu index redirect (`/clients` → its first visible screen), which
 *  must not land on a screen the user cannot see. */
export function firstVisibleScreenHref(menuHref: string, opts: NavAccess): string | null {
  const item = mainNavigation.find((m) => m.href === menuHref)
  if (!item || !canOpenMenu(menuHref, opts)) return null
  return visibleSubmenus(item.submenus, opts)[0]?.href ?? null
}

/** Whether the viewer may open an exact screen route. */
export function canOpenScreen(screenHref: string, opts: NavAccess): boolean {
  const item = mainNavigation.find((m) => m.submenus.some((s) => s.href === screenHref))
  if (!item) return true // not a nav screen (dashboard, settings, unknown) — not ours to gate
  if (!canOpenMenu(item.href, opts)) return false
  return visibleSubmenus(item.submenus, opts).some((s) => s.href === screenHref)
}

export interface MainMenuItem {
  id: string
  title: string
  icon: NavIcon
  href: string
  submenus: SubMenuItem[]
}

// Dashboard - standalone item at top.
// Its submenus are NOT declared here: they are the user's own dashboards, read
// at runtime from /user-profiles/me/dashboard (Header.tsx). The primary one
// stays at `/`; the others live under DASHBOARD_ROUTE_PREFIX.
export const dashboardItem: MainMenuItem = {
  id: 'dashboard',
  title: 'Tableau de bord',
  icon: LayoutDashboard,
  href: '/',
  submenus: [],
}

/** Route prefix of the non-primary dashboards. */
export const DASHBOARD_ROUTE_PREFIX = '/tableau-de-bord'

// Settings - standalone item at bottom
export const settingsItem: MainMenuItem = {
  id: 'settings',
  title: 'Paramètres',
  icon: Settings,
  href: '/settings',
  submenus: [
    { title: 'Utilisateurs', href: '/settings/utilisateurs', adminOnly: true },
  ],
}

// Main navigation items (between dashboard and settings).
// Order mirrors the legacy WinDev MPS main menu: Marketing, Clients,
// Sous-traitants, Transferts, Fils, Tombé Métier, Finis, Divers, Qualité,
// Rapports, Réseau.
export const mainNavigation: MainMenuItem[] = [
  {
    id: 'prospects',
    title: 'Prospects',
    icon: UserPlus,
    href: '/prospects',
    submenus: [
      { title: 'Demandes', href: '/prospects/demandes' },
    ],
  },
  {
    id: 'clients',
    title: 'Clients',
    icon: Users,
    href: '/clients',
    submenus: [
      { title: 'Commandes', href: '/clients/commandes' },
      { title: 'Devis', href: '/clients/devis' },
      { title: 'Expéditions', href: '/clients/expeditions' },
      { title: 'Facturation', href: '/clients/facturation' },
      { title: 'Gestion', href: '/clients/gestion' },
    ],
  },
  {
    id: 'sous-traitants',
    title: 'Sous-traitants',
    icon: Building2,
    href: '/sous-traitants',
    submenus: [
      { title: 'Commandes', href: '/sous-traitants/commandes' },
      { title: 'Gestion', href: '/sous-traitants/gestion' },
    ],
  },
  {
    id: 'transferts',
    title: 'Transferts',
    icon: Truck,
    href: '/transferts',
    submenus: [
      { title: 'Rouleaux', href: '/transferts/rouleaux' },
      { title: 'Fils', href: '/transferts/fils' },
    ],
  },
  {
    id: 'fils',
    title: 'Fils',
    icon: BobineIcon,
    href: '/fils',
    submenus: [
      { title: 'Références', href: '/fils/references' },
      { title: 'Stock', href: '/fils/stock' },
      { title: 'Commandes', href: '/fils/commandes' },
      { title: 'Gestion', href: '/fils/gestion' },
      { title: 'Prévisions', href: '/fils/previsions' },
    ],
  },
  {
    id: 'tombe-metier',
    title: 'Tombé Métier',
    icon: TmRollIcon,
    href: '/tombe-metier',
    submenus: [
      { title: 'Références', href: '/tombe-metier/references' },
      { title: 'Stock', href: '/tombe-metier/stock' },
    ],
  },
  {
    id: 'finis',
    title: 'Finis',
    icon: FiniRollIcon,
    href: '/finis',
    submenus: [
      { title: 'Références', href: '/finis/references' },
      { title: 'Stock', href: '/finis/stock' },
      { title: 'Études coloris', href: '/finis/etudes-coloris' },
      { title: 'Tarifs', href: '/finis/tarifs' },
    ],
  },
  {
    id: 'divers',
    title: 'Divers',
    icon: Box,
    href: '/divers',
    submenus: [
      { title: 'Références', href: '/divers/references' },
      { title: 'Stock', href: '/divers/stock' },
    ],
  },
  {
    id: 'qualite',
    title: 'Qualité',
    icon: ShieldCheck,
    href: '/qualite',
    submenus: [
      { title: 'Suivi lots', href: '/qualite/suivi-lots' },
      { title: 'Dossiers', href: '/qualite/dossiers' },
      { title: 'Actions', href: '/qualite/actions' },
      { title: 'Analyse', href: '/qualite/analyse' },
    ],
  },
  {
    id: 'rapports',
    title: 'Rapports',
    icon: FileBarChart,
    href: '/rapports',
    submenus: [
      { title: 'Commandes clients', href: '/rapports/commandes-clients' },
      { title: 'Commandes sst', href: '/rapports/commandes-sst' },
      { title: 'Commandes fils', href: '/rapports/commandes-fils' },
      { title: 'Finance', href: '/rapports/finance', permission: 'view_rapport_finance' },
    ],
  },
  {
    id: 'reseau',
    title: 'Réseau',
    icon: Globe,
    href: '/reseau',
    submenus: [
      { title: 'Entreprises', href: '/reseau/entreprises' },
    ],
  },
]

// Helper to find active menu based on current path
export function getActiveMenu(pathname: string): MainMenuItem | undefined {
  // Check dashboard — `/` plus every secondary dashboard of the current user
  if (pathname === dashboardItem.href || pathname.startsWith(DASHBOARD_ROUTE_PREFIX)) {
    return dashboardItem
  }
  // Check settings
  if (pathname === settingsItem.href || pathname.startsWith(settingsItem.href + '/')) {
    return settingsItem
  }
  // Check main navigation
  return mainNavigation.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + '/')
  )
}

// Route titles for breadcrumbs
export const routeTitles: Record<string, string> = {
  '/': 'Accueil',
  '/tableau-de-bord': 'Tableau de bord',
  // Prospects
  '/prospects': 'Prospects',
  '/prospects/demandes': 'Demandes',
  // Clients
  '/clients': 'Clients',
  '/clients/commandes': 'Commandes',
  '/clients/devis': 'Devis',
  '/clients/expeditions': 'Expéditions',
  '/clients/facturation': 'Facturation',
  '/clients/gestion': 'Gestion',
  // Sous-traitants
  '/sous-traitants': 'Sous-traitants',
  '/sous-traitants/commandes': 'Commandes',
  '/sous-traitants/gestion': 'Gestion',
  // Transferts
  '/transferts': 'Transferts',
  '/transferts/rouleaux': 'Rouleaux',
  '/transferts/fils': 'Fils',
  // Fils
  '/fils': 'Fils',
  '/fils/references': 'Références',
  '/fils/stock': 'Stock',
  '/fils/commandes': 'Commandes',
  '/fils/gestion': 'Gestion',
  '/fils/previsions': 'Prévisions',
  // Tombé Métier
  '/tombe-metier': 'Tombé Métier',
  '/tombe-metier/references': 'Références',
  '/tombe-metier/stock': 'Stock',
  // Finis
  '/finis': 'Finis',
  '/finis/references': 'Références',
  '/finis/stock': 'Stock',
  '/finis/etudes-coloris': 'Études coloris',
  '/finis/tarifs': 'Tarifs',
  // Divers
  '/divers': 'Divers',
  '/divers/references': 'Références',
  '/divers/stock': 'Stock',
  // Qualité
  '/qualite': 'Qualité',
  '/qualite/suivi-lots': 'Suivi lots',
  '/qualite/dossiers': 'Dossiers',
  '/qualite/actions': 'Actions',
  '/qualite/analyse': 'Analyse',
  // Rapports
  '/rapports': 'Rapports',
  '/rapports/commandes-clients': 'Commandes clients',
  '/rapports/commandes-sst': 'Commandes sst',
  '/rapports/commandes-fils': 'Commandes fils',
  '/rapports/finance': 'Finance',
  // Réseau
  '/reseau': 'Réseau',
  '/reseau/entreprises': 'Entreprises',
  // Settings
  '/settings': 'Paramètres',
  '/settings/utilisateurs': 'Utilisateurs',
}
