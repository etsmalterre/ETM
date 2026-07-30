// Screen access — which menus and screens a user can open.
//
// This is a SECOND axis, next to the action catalog in permission-keys.ts, and
// it deliberately mixes two directions:
//
//   • MENU level is a GRANT, default closed  — `screen_<menu>`
//     A user sees nothing until the menu is granted, which is the "default
//     closed" rule the rest of the permission system follows.
//
//   • SCREEN level is a HIDE, inside a granted menu — `hide_<menu>_<screen>`
//     Granting a menu grants every screen under it; individual screens are
//     taken away one by one. This is what keeps a newly shipped screen from
//     being invisible to the whole company until an admin ticks it for every
//     user — a real chore in a project that adds screens weekly. A genuinely
//     confidential new screen gets its own action key (see view_rapport_finance),
//     which is the tool for confidentiality; this axis is about decluttering.
//
// Read as one sentence: "you grant menus; inside a menu you can remove screens."
// The admin UI renders both as one checkbox tree, so nobody has to think about
// which direction the storage runs.
//
// ⚠️ Screen access is enforced on the nav surfaces and the router ONLY — it is
// not a security boundary. Endpoints are shared across screens (client lookups,
// /stock/ecru/suivi feeding a dashboard widget…), so gating them per screen
// would break unrelated features. Confidential data is gated by its own action
// key, checked server-side. When a screen genuinely must be unreadable, add
// such a key rather than relying on the menu being hidden.
//
// Keys are stored verbatim in permissions.json — renaming one needs a migration.
//
// This manifest MIRRORS apps/web/src/config/navigation.ts (the web builds the
// admin tree and the nav filters from `mainNavigation` directly, so it can
// never drift; this copy exists so the API can validate what it stores and so
// the seed script knows the menu list). Kept honest by
// `src/scripts/check-screen-access.ts`, which diffs the two files.

export interface ScreenDef {
  /** Route of the screen, e.g. '/clients/facturation'. */
  href: string
  label: string
}

export interface MenuDef {
  /** Nav id, e.g. 'sous-traitants'. */
  id: string
  /** Route of the menu itself, e.g. '/sous-traitants'. */
  href: string
  label: string
  screens: readonly ScreenDef[]
}

export const SCREEN_MENUS: readonly MenuDef[] = [
  {
    id: 'prospects',
    href: '/prospects',
    label: 'Prospects',
    screens: [{ href: '/prospects/demandes', label: 'Demandes' }],
  },
  {
    id: 'clients',
    href: '/clients',
    label: 'Clients',
    screens: [
      { href: '/clients/commandes', label: 'Commandes' },
      { href: '/clients/devis', label: 'Devis' },
      { href: '/clients/expeditions', label: 'Expéditions' },
      { href: '/clients/facturation', label: 'Facturation' },
      { href: '/clients/gestion', label: 'Gestion' },
    ],
  },
  {
    id: 'sous-traitants',
    href: '/sous-traitants',
    label: 'Sous-traitants',
    screens: [
      { href: '/sous-traitants/commandes', label: 'Commandes' },
      { href: '/sous-traitants/gestion', label: 'Gestion' },
    ],
  },
  {
    id: 'transferts',
    href: '/transferts',
    label: 'Transferts',
    screens: [
      { href: '/transferts/rouleaux', label: 'Rouleaux' },
      { href: '/transferts/fils', label: 'Fils' },
    ],
  },
  {
    id: 'fils',
    href: '/fils',
    label: 'Fils',
    screens: [
      { href: '/fils/references', label: 'Références' },
      { href: '/fils/stock', label: 'Stock' },
      { href: '/fils/commandes', label: 'Commandes' },
      { href: '/fils/gestion', label: 'Gestion' },
      { href: '/fils/previsions', label: 'Prévisions' },
    ],
  },
  {
    id: 'tombe-metier',
    href: '/tombe-metier',
    label: 'Tombé Métier',
    screens: [
      { href: '/tombe-metier/references', label: 'Références' },
      { href: '/tombe-metier/stock', label: 'Stock' },
    ],
  },
  {
    id: 'finis',
    href: '/finis',
    label: 'Finis',
    screens: [
      { href: '/finis/references', label: 'Références' },
      { href: '/finis/stock', label: 'Stock' },
      { href: '/finis/etudes-coloris', label: 'Études coloris' },
      { href: '/finis/tarifs', label: 'Tarifs' },
    ],
  },
  {
    id: 'divers',
    href: '/divers',
    label: 'Divers',
    screens: [
      { href: '/divers/references', label: 'Références' },
      { href: '/divers/stock', label: 'Stock' },
    ],
  },
  {
    id: 'qualite',
    href: '/qualite',
    label: 'Qualité',
    screens: [
      { href: '/qualite/suivi-lots', label: 'Suivi lots' },
      { href: '/qualite/dossiers', label: 'Dossiers' },
      { href: '/qualite/actions', label: 'Actions' },
      { href: '/qualite/analyse', label: 'Analyse' },
    ],
  },
  {
    id: 'rapports',
    href: '/rapports',
    label: 'Rapports',
    screens: [
      { href: '/rapports/commandes-clients', label: 'Commandes clients' },
      { href: '/rapports/commandes-sst', label: 'Commandes sst' },
      { href: '/rapports/commandes-fils', label: 'Commandes fils' },
      { href: '/rapports/finance', label: 'Finance' },
    ],
  },
  {
    id: 'reseau',
    href: '/reseau',
    label: 'Réseau',
    screens: [{ href: '/reseau/entreprises', label: 'Entreprises' }],
  },
] as const

/** '/sous-traitants/commandes' → 'sous_traitants_commandes' */
function slug(href: string): string {
  return href.replace(/^\//, '').replace(/[/-]/g, '_')
}

/** Grant key for a whole menu. Default closed: no key, no menu. */
export function menuAccessKey(menuHref: string): string {
  return `screen_${slug(menuHref)}`
}

/** Hide key for one screen inside a granted menu. Absent = visible. */
export function screenHideKey(screenHref: string): string {
  return `hide_${slug(screenHref)}`
}

/** Every menu grant key — what the seed script hands out and what an
 *  effective admin is reported as holding. */
export function allMenuAccessKeys(): string[] {
  return SCREEN_MENUS.map((m) => menuAccessKey(m.href))
}

const VALID_SCREEN_KEYS: ReadonlySet<string> = new Set([
  ...SCREEN_MENUS.map((m) => menuAccessKey(m.href)),
  ...SCREEN_MENUS.flatMap((m) => m.screens.map((s) => screenHideKey(s.href))),
])

/** True for a key belonging to this axis (menu grant or screen hide). */
export function isScreenAccessKey(k: string): boolean {
  return VALID_SCREEN_KEYS.has(k)
}
