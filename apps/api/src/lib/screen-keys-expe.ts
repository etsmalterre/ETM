// Expe screen access: which menus and screens an Expe user can open.
//
// Mirror of lib/screen-keys.ts and lib/screen-keys-trm.ts over Expe's
// navigation (repo expe, apps/web/src/ecrans.ts), a SEPARATE module for the
// same reason: its own menus, its own store (lib/permissions-expe.ts). The key
// shapes are the two ERPs':
//
//   • MENU level is a GRANT, default closed: `screen_<menu>`
//   • SCREEN level is a HIDE, inside a granted menu: `hide_<menu>_<screen>`
//
// Read as one sentence: « you grant menus; inside a menu you can remove
// screens ». Enforced on the nav and the router only, never a security
// boundary: confidential data gets its own action key in
// permission-keys-expe.ts, checked server side.
//
// EMPTY for now: Expe has no screen but its home, which every member opens
// (being a member is the right to enter, lib/expe-acces.ts). Each screen of
// docs/plan.md §6 (À faire partir, En route, Livrés, Sur place, Transporteurs)
// gets its row here when it is built, mirrored by hand from Expe's ecrans.ts:
// the Console Administration reads this manifest (GET /permissions-expe/screens)
// to draw the Écrans tab, since it cannot import Expe's navigation.

export interface ExpeScreenDef {
  /** Route of the screen, e.g. '/transporteurs/fiche'. */
  href: string
  label: string
}

export interface ExpeMenuDef {
  /** Nav id, e.g. 'en-route'. */
  id: string
  /** Route of the menu itself, e.g. '/en-route'. */
  href: string
  label: string
  screens: readonly ExpeScreenDef[]
  /** false = granted person by person, never to everybody at once. */
  seed?: false
}

export const EXPE_SCREEN_MENUS: readonly ExpeMenuDef[] = []

/** '/a-faire-partir' → 'a_faire_partir' */
function slug(href: string): string {
  return href.replace(/^\//, '').replace(/[/-]/g, '_')
}

/** Grant key for a whole menu. Default closed: no key, no menu. */
export function expeMenuAccessKey(menuHref: string): string {
  return `screen_${slug(menuHref)}`
}

/** Hide key for one screen inside a granted menu. Absent = visible. */
export function expeScreenHideKey(screenHref: string): string {
  return `hide_${slug(screenHref)}`
}

/** Every menu grant key: what an effective admin is reported as holding. */
export function allExpeMenuAccessKeys(): string[] {
  return EXPE_SCREEN_MENUS.map((m) => expeMenuAccessKey(m.href))
}

const VALID_EXPE_SCREEN_KEYS: ReadonlySet<string> = new Set([
  ...EXPE_SCREEN_MENUS.map((m) => expeMenuAccessKey(m.href)),
  ...EXPE_SCREEN_MENUS.flatMap((m) => m.screens.map((s) => expeScreenHideKey(s.href))),
])

/** True for a key belonging to this axis (menu grant or screen hide). */
export function isExpeScreenAccessKey(k: string): boolean {
  return VALID_EXPE_SCREEN_KEYS.has(k)
}
