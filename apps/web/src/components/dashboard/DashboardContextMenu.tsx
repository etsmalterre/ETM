// Right-click accelerator for the tableau de bord.
//
// Secondary path only — the visible entry point is the "Personnaliser" button
// in the header. Right-click is undiscoverable on its own and doesn't exist on
// touch (§40 treats tablets/phones as first-class), so nothing here may be the
// only way to reach an action.
//
// Gated to the dashboard BACKGROUND: right-clicking inside a widget keeps the
// native browser menu so users can still copy a client name out of the CA
// table. In edit mode the widget bodies are `pointer-events-none`, so a
// right-click there falls through to the background and does open the menu —
// which is what you want while rearranging.
//
// Styling follows the §42 DocMenuButton / §29.4 status-menu conventions
// (white popover, border, shadow-lg, hover:bg-zinc-100 rows) rather than Radix
// ContextMenu: the target-gating above needs manual control of when the menu
// opens, and both existing menus in the app are hand-rolled the same way.

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ContextMenuItem {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void
}

/** Viewport-clamped menu position, so a right-click near an edge stays visible. */
const MENU_WIDTH = 264
const MENU_ROW_HEIGHT = 36
const EDGE_PADDING = 8

export function DashboardContextMenu({
  items, children, className,
}: {
  items: ContextMenuItem[]
  children: ReactNode
  className?: string
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setPos(null), [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element | null
    // The screen portals its header actions into the app header, and React
    // bubbles portal events through the REACT tree — so a right-click up in
    // the header would land here. Only react to events physically inside the
    // dashboard's own DOM subtree.
    if (!target || !rootRef.current?.contains(target)) return
    // Inside a widget → leave the native menu alone (text selection / copy).
    if (target.closest?.('.card-premium')) return
    if (items.length === 0) return
    e.preventDefault()
    const height = items.length * MENU_ROW_HEIGHT + 8
    setPos({
      x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH - EDGE_PADDING),
      y: Math.min(e.clientY, window.innerHeight - height - EDGE_PADDING),
    })
  }, [items.length])

  // Dismiss on outside click, Escape, scroll or resize — the menu is pinned to
  // viewport coordinates, so anything that moves the page must close it.
  useEffect(() => {
    if (!pos) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pos, close])

  return (
    <div ref={rootRef} onContextMenu={handleContextMenu} className={className}>
      {children}
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
          className="fixed z-50 rounded-lg border bg-white shadow-lg overflow-hidden"
        >
          {items.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => { item.onSelect(); close() }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                  'hover:bg-zinc-100 focus:outline-none focus-visible:bg-zinc-100',
                )}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
