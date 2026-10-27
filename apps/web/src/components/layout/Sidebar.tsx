import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dashboardItem, type MainMenuItem } from '@/config/navigation'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/context-menu'
import { useUser } from '@/contexts/UserContext'
import { useVisibleMainNavigation } from '@/hooks/useSubmenuFilter'
import { AppLogo } from './AppLogo'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  className?: string
}

interface NavItemProps {
  item: MainMenuItem
  collapsed: boolean
  pathname: string
  onNavigate: (href: string) => void
}

function NavItem({ item, collapsed, pathname, onNavigate }: NavItemProps) {
  const Icon = item.icon
  const isActive =
    pathname === item.href || pathname.startsWith(item.href + '/')
  const targetHref = item.submenus.length > 0 ? item.submenus[0].href : item.href

  const contextMenuItems: ContextMenuItem[] = item.submenus.map((sub) => ({
    label: sub.title,
    href: sub.href,
  }))

  const handleContextSelect = (menuItem: ContextMenuItem) => {
    onNavigate(menuItem.href)
  }

  const navLinkContent = collapsed ? (
    <NavLink
      to={targetHref}
      title={item.title}
      className={cn(
        'flex h-12 w-full items-center justify-center rounded-md transition-all relative',
        isActive
          ? 'bg-white/20 text-white'
          : 'text-white/85 hover:bg-white/10 hover:text-white'
      )}
    >
      {isActive && (
        <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
      )}
      <Icon className="h-5 w-5" />
    </NavLink>
  ) : (
    <NavLink
      to={targetHref}
      className={cn(
        'flex h-12 items-center gap-3 rounded-md px-3 text-sm font-medium transition-all relative',
        isActive
          ? 'bg-white/20 text-white'
          : 'text-white/85 hover:bg-white/10 hover:text-white'
      )}
    >
      {isActive && (
        <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
      )}
      <Icon className="h-5 w-5 shrink-0" />
      <span className="truncate">{item.title}</span>
    </NavLink>
  )

  // Only wrap with context menu if there are submenus
  if (contextMenuItems.length > 0) {
    return (
      <ContextMenu items={contextMenuItems} onSelect={handleContextSelect}>
        {navLinkContent}
      </ContextMenu>
    )
  }

  return navLinkContent
}

export function Sidebar({ collapsed, onToggle, className }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  useUser() // ensures the sidebar re-renders when the user context updates

  const handleNavigate = (href: string) => {
    navigate(href)
  }

  // A menu the user wasn't granted, or one whose every screen is hidden,
  // disappears entirely — and the ones that stay carry only the screens the
  // user may open, so the right-click context menu and the item's landing
  // target can't point at a forbidden route. Paramètres, Agents IA and RH live
  // in the Console Administration since 2026-10-27 (profile menu link).
  const visibleMain = useVisibleMainNavigation()

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 h-screen flex-col border-r border-primary/20 transition-all duration-300',
        'bg-gradient-to-b from-primary via-primary/95 to-primary/90',
        collapsed ? 'w-16' : 'w-64',
        className
      )}
    >
      {/* Logo + app tag; the logo switches to the other app (#1231) */}
      <AppLogo app="etm" collapsed={collapsed} />

      {/* Navigation */}
      <ScrollArea className="flex-1 py-4">
        <nav className="space-y-1 px-2">
          {/* Dashboard at top */}
          <NavItem
            item={dashboardItem}
            collapsed={collapsed}
            pathname={location.pathname}
            onNavigate={handleNavigate}
          />

          {/* Separator */}
          <div className="my-2 border-t border-white/10" />

          {/* Main navigation */}
          {visibleMain.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              collapsed={collapsed}
              pathname={location.pathname}
              onNavigate={handleNavigate}
            />
          ))}
        </nav>
      </ScrollArea>

      {/* Collapse Toggle */}
      <div className="border-t border-white/10 p-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="w-full text-white/85 hover:text-white hover:bg-white/10"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
    </aside>
  )
}
