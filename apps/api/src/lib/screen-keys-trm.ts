// TRM screen access — which menus and screens a TRM user can open.
//
// Mirror of lib/screen-keys.ts over the TRM navigation tree, and a SEPARATE
// module on purpose: the two apps have different menus, and their grants live
// in different stores (permissions.json vs permissions-trm.json — see the
// header of lib/permissions-trm.ts). The key *shapes* are identical, so a
// couple of slugs collide by name across the two files (`screen_clients`);
// they never meet, because each store is filtered by its own catalog.
//
// The axis deliberately mixes two directions, exactly like ETM's:
//
//   • MENU level is a GRANT, default closed  — `screen_<menu>`
//     A user sees nothing until the menu is granted.
//
//   • SCREEN level is a HIDE, inside a granted menu — `hide_<menu>_<screen>`
//     Granting a menu grants every screen under it; screens are taken away one
//     by one, so a newly shipped screen is immediately visible to everyone who
//     already has its menu instead of being invisible until an admin ticks it
//     for every user.
//
// Read as one sentence: "you grant menus; inside a menu you can remove screens."
//
// ⚠️ Screen access is enforced on the nav surfaces and the router ONLY — it is
// not a security boundary. Endpoints are shared across screens, so gating them
// per screen would break unrelated features. Confidential data gets its own
// action key in permission-keys-trm.ts, checked server-side.
//
// Keys are stored verbatim in permissions-trm.json — renaming one needs a
// migration.
//
// This manifest MIRRORS TRM's apps/web/src/config/navigation.ts (the web builds
// the admin tree and the nav filters from `mainNavigation` directly, so the UI
// can never drift; this copy exists so the API can validate what it stores and
// so the seed script knows the menu list). Kept honest by
// `src/scripts/check-screen-access-trm.ts`, which diffs the two files.

export interface TrmScreenDef {
  /** Route of the screen, e.g. '/clients/facturation'. */
  href: string
  label: string
}

export interface TrmMenuDef {
  /** Nav id, e.g. 'tombe-metier'. */
  id: string
  /** Route of the menu itself, e.g. '/clients'. */
  href: string
  label: string
  screens: readonly TrmScreenDef[]
}

export const TRM_SCREEN_MENUS: readonly TrmMenuDef[] = [
  {
    id: 'clients',
    href: '/clients',
    label: 'Clients',
    screens: [
      { href: '/clients/commandes', label: 'Commandes' },
      { href: '/clients/expeditions', label: 'Expéditions' },
      { href: '/clients/facturation', label: 'Facturation' },
      { href: '/clients/gestion', label: 'Gestion' },
    ],
  },
  {
    id: 'fils',
    href: '/fils',
    label: 'Fils',
    screens: [
      { href: '/fils/references', label: 'Références' },
      { href: '/fils/stock', label: 'Stock' },
      { href: '/fils/fournisseurs', label: 'Fournisseurs' },
    ],
  },
  {
    id: 'tombe-metier',
    href: '/tombe-metier',
    label: 'Tombé Métier',
    screens: [
      { href: '/tombe-metier/references', label: 'Références' },
      { href: '/tombe-metier/echantillons', label: 'Échantillons' },
      { href: '/tombe-metier/stock', label: 'Stock' },
    ],
  },
  {
    id: 'production',
    href: '/production',
    label: 'Production',
    screens: [
      { href: '/production/of', label: 'Ordres de fabrication' },
      { href: '/production/visitage', label: 'Visitage' },
      { href: '/production/prime', label: 'Prime' },
      { href: '/production/trs', label: 'TRS' },
    ],
  },
  {
    id: 'atelier',
    href: '/atelier',
    label: 'Atelier',
    screens: [
      { href: '/atelier/maintenance', label: 'Maintenance' },
      { href: '/atelier/bonnetier', label: 'Bonnetier' },
      { href: '/atelier/planning', label: 'Planning' },
    ],
  },
  {
    id: 'qualite',
    href: '/qualite',
    label: 'Qualité',
    screens: [
      { href: '/qualite/defauts-recents', label: 'Défauts récents' },
      { href: '/qualite/retour-client', label: 'Retour client' },
      { href: '/qualite/analyse', label: 'Analyse' },
    ],
  },
  {
    id: 'rapports',
    href: '/rapports',
    label: 'Rapports',
    screens: [
      { href: '/rapports/finance', label: 'Finance' },
    ],
  },
] as const

/** '/tombe-metier/references' → 'tombe_metier_references' */
function slug(href: string): string {
  return href.replace(/^\//, '').replace(/[/-]/g, '_')
}

/** Grant key for a whole menu. Default closed: no key, no menu. */
export function trmMenuAccessKey(menuHref: string): string {
  return `screen_${slug(menuHref)}`
}

/** Hide key for one screen inside a granted menu. Absent = visible. */
export function trmScreenHideKey(screenHref: string): string {
  return `hide_${slug(screenHref)}`
}

/** Every menu grant key — what the seed script hands out and what an
 *  effective admin is reported as holding. */
export function allTrmMenuAccessKeys(): string[] {
  return TRM_SCREEN_MENUS.map((m) => trmMenuAccessKey(m.href))
}

const VALID_TRM_SCREEN_KEYS: ReadonlySet<string> = new Set([
  ...TRM_SCREEN_MENUS.map((m) => trmMenuAccessKey(m.href)),
  ...TRM_SCREEN_MENUS.flatMap((m) => m.screens.map((s) => trmScreenHideKey(s.href))),
])

/** True for a key belonging to this axis (menu grant or screen hide). */
export function isTrmScreenAccessKey(k: string): boolean {
  return VALID_TRM_SCREEN_KEYS.has(k)
}
