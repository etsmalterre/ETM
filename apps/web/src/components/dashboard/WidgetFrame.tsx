// Shared chrome for every tableau de bord widget: the compact navy header band
// (gold icon tile, white title, widget-specific actions) — see mps_designer §43.
//
// In "Personnaliser" mode the widget carries NO control panel — the whole card
// is the drag handle (grab cursor + a hand hint in the header), and sizing is
// done by dragging the card's edges (the handles are rendered by the Dashboard,
// which owns the grid maths). The only button is a hover-revealed "hide", and
// even that is a shortcut: dragging a widget into the tray hides it too.
//
// Widgets render <WidgetFrame> themselves so they keep ownership of their own
// title and header actions; the edit state reaches the frame through
// WidgetChromeContext, which the Dashboard provides per widget.

import { createContext, useContext, type ReactNode, type ComponentType } from 'react'
import { Hand, EyeOff } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface WidgetChrome {
  isEditing: boolean
  onHide: () => void
}

const WidgetChromeContext = createContext<WidgetChrome | null>(null)

export function WidgetChromeProvider({
  chrome, children,
}: {
  chrome: WidgetChrome
  children: ReactNode
}) {
  return <WidgetChromeContext.Provider value={chrome}>{children}</WidgetChromeContext.Provider>
}

/** Widgets read this to adapt their own body to an explicit height. */
export function useWidgetChrome(): WidgetChrome | null {
  return useContext(WidgetChromeContext)
}

export function WidgetFrame({
  icon: Icon, title, actions, children,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  /** View-mode controls rendered at the right of the navy band. Hidden while
   *  customising — the widget body is inert there, so its controls would lie. */
  actions?: ReactNode
  children: ReactNode
}) {
  const chrome = useWidgetChrome()
  const isEditing = chrome?.isEditing ?? false

  return (
    <Card
      className={cn(
        // Every widget has a concrete height (registry default or dragged), and
        // the grid gives its slot exactly that — so the card always fills it.
        // `group/widget` drives the hover-revealed hide button below.
        'card-premium group/widget overflow-hidden flex h-full flex-col',
        isEditing && 'ring-1 ring-accent/40',
      )}
    >
      {/* Header band — the brand's core pairing, borrowed from the sidebar:
          navy surface, white title, gold accent. A gold band here was a one-off
          invention that fought the gold app header and swallowed the gold icon;
          a zinc one read as dead weight. The gold hairline underneath echoes
          the accent rule under every detail header (mps_designer §6). */}
      <div className="flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 flex-shrink-0">
        {/* §9: the icon tile flips to white in edit mode — the same
            "this header is live" signal every edit-aware header in the app
            uses, restated for a dark band. */}
        <div
          className={cn(
            'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
            isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground',
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <h2 className="min-w-0 flex-1 text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
          {title}
        </h2>
        {isEditing && chrome ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Affordance only — the drag handle is the whole card. */}
            <Hand className="h-4 w-4 text-gold" aria-hidden />
            <button
              type="button"
              onClick={chrome.onHide}
              onPointerDown={(e) => e.stopPropagation()}
              title="Masquer ce widget"
              aria-label="Masquer ce widget"
              // widget-no-drag: excluded from the grid's whole-card drag handle
              // (react-grid-layout `draggableCancel`).
              className="widget-no-drag rounded-md p-1 text-white/70 opacity-0 transition-opacity hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 group-hover/widget:opacity-100 focus-visible:opacity-100"
            >
              <EyeOff className="h-4 w-4" />
            </button>
          </div>
        ) : (
          actions
        )}
      </div>

      {/* Body — inert while customising so a click can't fire a widget action.
          Content taller than the card's height scrolls inside it. */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-auto scrollbar-transparent',
          isEditing && 'pointer-events-none select-none',
        )}
      >
        {children}
      </div>
    </Card>
  )
}
