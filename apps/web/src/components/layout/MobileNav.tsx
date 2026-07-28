import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { mainNavigation, dashboardItem, settingsItem, type MainMenuItem } from '@/config/navigation'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useSubmenuFilter } from '@/hooks/useSubmenuFilter'

interface MobileNavProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileNav({ open, onOpenChange }: MobileNavProps) {
  const filterSubmenus = useSubmenuFilter()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-80 p-0 bg-gradient-to-b from-primary via-primary/95 to-primary/90 border-r-0">
        <SheetHeader className="border-b border-white/10 px-6 h-14 flex items-center">
          <SheetTitle className="flex items-center gap-2">
            <span className="font-semibold text-2xl">
              <span className="text-accent">MPS</span>
            </span>
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-65px)]">
          <nav className="space-y-1 p-4">
            {/* Dashboard */}
            <MobileNavItemSimple
              item={dashboardItem}
              onNavigate={() => onOpenChange(false)}
            />

            {/* Separator */}
            <div className="my-2 border-t border-white/10" />

            {/* Main navigation */}
            {mainNavigation.map((item) => (
              <MobileNavItem
                key={item.id}
                item={{ ...item, submenus: filterSubmenus(item.submenus) }}
                onNavigate={() => onOpenChange(false)}
              />
            ))}

            {/* Separator */}
            <div className="my-2 border-t border-white/10" />

            {/* Settings */}
            <MobileNavItemSimple
              item={settingsItem}
              onNavigate={() => onOpenChange(false)}
            />
          </nav>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

interface MobileNavItemProps {
  item: MainMenuItem
  onNavigate: () => void
}

// Simple nav item for dashboard/settings (no submenus)
function MobileNavItemSimple({ item, onNavigate }: MobileNavItemProps) {
  const location = useLocation()
  const Icon = item.icon
  const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + '/')

  return (
    <NavLink
      to={item.href}
      onClick={onNavigate}
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
}

function MobileNavItem({ item, onNavigate }: MobileNavItemProps) {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const Icon = item.icon
  const isActive =
    location.pathname === item.href ||
    location.pathname.startsWith(item.href + '/')

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex h-12 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-all relative',
          isActive
            ? 'bg-white/20 text-white'
            : 'text-white/85 hover:bg-white/10 hover:text-white'
        )}
      >
        {isActive && (
          <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
        )}
        <Icon className="h-5 w-5 shrink-0" />
        <span className="flex-1 text-left truncate">{item.title}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 pt-1">
        {item.submenus.map((submenu) => (
          <NavLink
            key={submenu.href}
            to={submenu.href}
            onClick={onNavigate}
            className={({ isActive: linkActive }) =>
              cn(
                'flex h-10 items-center gap-3 rounded-md px-3 pl-10 text-sm transition-all',
                linkActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-white/75 hover:bg-white/10 hover:text-white'
              )
            }
          >
            <span className="truncate">{submenu.title}</span>
          </NavLink>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
