import { describe, it, expect } from 'vitest'
import {
  mainNavigation,
  settingsItem,
  screenAccessMenus,
  visibleSettingsItem,
  visibleMainNavigation,
  visibleSubmenus,
  canOpenScreen,
  firstVisibleScreenHref,
  menuAccessKey,
  screenHideKey,
  type NavAccess,
} from './navigation'

/** A non-admin viewer holding exactly `keys`. */
function viewer(keys: string[]): NavAccess {
  const set = new Set(keys)
  return {
    isEffectiveAdmin: false,
    has: (k) => set.has(k),
    hasRaw: (k) => set.has(k),
  }
}

/** An effective admin, as GET /permissions/me reports them: the bypass on
 *  `has`, and a raw set that deliberately contains no hide keys. */
function admin(): NavAccess {
  const set = new Set(mainNavigation.map((m) => menuAccessKey(m.href)))
  return {
    isEffectiveAdmin: true,
    has: () => true,
    hasRaw: (k) => set.has(k),
  }
}

const ALL_MENUS = mainNavigation.map((m) => menuAccessKey(m.href))
const ids = (menus: { id: string }[]) => menus.map((m) => m.id)

describe('screen access — menu grants', () => {
  it('is default closed: a user with no keys sees no menu at all', () => {
    expect(visibleMainNavigation(viewer([]))).toEqual([])
  })

  it('granting a menu grants every screen under it', () => {
    const v = viewer([menuAccessKey('/fils')])
    const menus = visibleMainNavigation(v)
    expect(ids(menus)).toEqual(['fils'])
    expect(menus[0].submenus.map((s) => s.href)).toEqual(
      mainNavigation.find((m) => m.id === 'fils')!.submenus.map((s) => s.href),
    )
  })

  it('an ungranted menu is closed even if its screens carry no hide key', () => {
    expect(canOpenScreen('/fils/stock', viewer([]))).toBe(false)
    expect(canOpenScreen('/fils/stock', viewer([menuAccessKey('/fils')]))).toBe(true)
  })
})

describe('screen access — per-screen hides', () => {
  it('hides one screen and leaves the rest of the menu', () => {
    const v = viewer([menuAccessKey('/clients'), screenHideKey('/clients/facturation')])
    const clients = visibleMainNavigation(v).find((m) => m.id === 'clients')!
    expect(clients.submenus.map((s) => s.href)).not.toContain('/clients/facturation')
    expect(clients.submenus.map((s) => s.href)).toContain('/clients/commandes')
    expect(canOpenScreen('/clients/facturation', v)).toBe(false)
    expect(canOpenScreen('/clients/commandes', v)).toBe(true)
  })

  it('drops the menu once every one of its screens is hidden', () => {
    const transferts = mainNavigation.find((m) => m.id === 'transferts')!
    const v = viewer([
      menuAccessKey('/transferts'),
      ...transferts.submenus.map((s) => screenHideKey(s.href)),
    ])
    expect(ids(visibleMainNavigation(v))).toEqual([])
  })

  it('sends the menu index to the first screen the user can still open', () => {
    const v = viewer([menuAccessKey('/clients'), screenHideKey('/clients/commandes')])
    expect(firstVisibleScreenHref('/clients', v)).toBe('/clients/devis')
    expect(firstVisibleScreenHref('/clients', viewer([]))).toBeNull()
  })
})

describe('screen access — effective admin', () => {
  it('sees every menu and every screen', () => {
    const a = admin()
    expect(ids(visibleMainNavigation(a))).toEqual(ids(mainNavigation))
    for (const m of mainNavigation) {
      for (const s of m.submenus) expect(canOpenScreen(s.href, a)).toBe(true)
    }
  })

  it('is NOT hidden by hide keys — they must be read without the bypass', () => {
    // The regression this guards: reading a hide key through has(), which
    // returns true for every key when the viewer is an effective admin, would
    // hide the whole app from the admin.
    const a = admin()
    expect(visibleSubmenus(mainNavigation[1].submenus, a).length).toBeGreaterThan(0)
  })
})

describe('screen access — interaction with the action catalog', () => {
  it('keeps a submenu permission gate: Finance needs its own key', () => {
    const rapports = mainNavigation.find((m) => m.id === 'rapports')!
    const finance = rapports.submenus.find((s) => s.href === '/rapports/finance')!
    expect(finance.permission).toBe('view_rapport_finance')

    const withoutKey = viewer([menuAccessKey('/rapports')])
    expect(canOpenScreen('/rapports/finance', withoutKey)).toBe(false)
    const withKey = viewer([menuAccessKey('/rapports'), 'view_rapport_finance'])
    expect(canOpenScreen('/rapports/finance', withKey)).toBe(true)
  })

  it('leaves non-nav routes alone (dashboard, unknown) but gates Paramètres', () => {
    const v = viewer([])
    expect(canOpenScreen('/', v)).toBe(true)
    expect(canOpenScreen('/nulle-part', v)).toBe(true)
    expect(canOpenScreen('/settings/outils', v)).toBe(false)
  })
})

describe('screen access — the Laetitia case', () => {
  it('grants everything but the 7 menus she does not need', () => {
    const unwanted = [
      '/sous-traitants', '/transferts', '/fils',
      '/tombe-metier', '/divers', '/rapports', '/reseau',
    ].map(menuAccessKey)
    const v = viewer(ALL_MENUS.filter((k) => !unwanted.includes(k)))
    expect(ids(visibleMainNavigation(v))).toEqual(['prospects', 'clients', 'finis', 'qualite', 'agents-ia'])
  })
})

describe('Paramètres — a menu of the Écrans axis', () => {
  const titles = (v: NavAccess) => visibleSettingsItem(v)?.submenus.map((s) => s.title) ?? null
  const SETTINGS = menuAccessKey('/settings')

  it('shows Outils to a non-admin granted the Paramètres menu, and nothing else', () => {
    expect(titles(viewer([SETTINGS]))).toEqual(['Outils'])
    expect(canOpenScreen('/settings/outils', viewer([SETTINGS]))).toBe(true)
  })

  it('hides the whole menu from a non-admin without the grant, even holding every other menu', () => {
    expect(titles(viewer(ALL_MENUS))).toBeNull()
    expect(canOpenScreen('/settings/outils', viewer(ALL_MENUS))).toBe(false)
  })

  it('drops the menu when its only screen is hidden', () => {
    const v = viewer([SETTINGS, screenHideKey('/settings/outils')])
    expect(titles(v)).toBeNull()
    expect(firstVisibleScreenHref('/settings', v)).toBeNull()
  })

  it('never opens Utilisateurs to a non-admin, whatever they hold', () => {
    expect(canOpenScreen('/settings/utilisateurs', viewer([SETTINGS]))).toBe(false)
    expect(firstVisibleScreenHref('/settings', viewer([SETTINGS]))).toBe('/settings/outils')
  })

  it('shows both entries to the effective admin', () => {
    expect(titles(admin())).toEqual(['Utilisateurs', 'Outils'])
    expect(firstVisibleScreenHref('/settings', admin())).toBe('/settings/utilisateurs')
  })

  it('is part of the Écrans tree next to the main menus', () => {
    expect(screenAccessMenus().map((m) => m.id)).toEqual([...ids(mainNavigation), settingsItem.id])
  })
})
