import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** top / bottom only: 'start' pins the tooltip to the trigger's left edge
   *  instead of centering it. */
  align?: 'center' | 'start'
  delayDuration?: number
  /** on the trigger wrapper, e.g. `flex w-full` when the trigger must span its row */
  className?: string
  /** placed under the mouse pointer and moving with it (a wide trigger such as a gauge) */
  followCursor?: boolean
}

const GAP = 8
const MARGIN = 8

// Portaled to <body> with fixed coordinates: an overflow panel (a line card in a
// scroll area, a drawer) must never clip it.
function Tooltip({
  content,
  children,
  side = 'right',
  align = 'center',
  delayDuration = 200,
  className,
  followCursor = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = React.useState(false)
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>()
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  // Last pointer position, for followCursor.
  const cursor = React.useRef<{ x: number; y: number } | null>(null)

  /** Under-right of the pointer, kept on screen. */
  const placeAtCursor = () => {
    const tip = tipRef.current
    const c = cursor.current
    if (!tip || !c) return
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let left = c.x + 12
    let top = c.y + 16
    if (left + w > window.innerWidth - MARGIN) left = c.x - 12 - w
    if (top + h > window.innerHeight - MARGIN) top = c.y - 12 - h
    setPos({ top: Math.max(MARGIN, top), left: Math.max(MARGIN, left) })
  }

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true)
    }, delayDuration)
  }

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    setIsVisible(false)
    setPos(null)
  }

  React.useEffect(() => () => clearTimeout(timeoutRef.current), [])

  React.useLayoutEffect(() => {
    if (!isVisible) return
    if (followCursor) { placeAtCursor(); return }
    const place = () => {
      const trigger = triggerRef.current
      const tip = tipRef.current
      if (!trigger || !tip) return
      const t = trigger.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      let top: number
      let left: number
      // Flip to the other side when the asked one has no room (a tall tooltip asked « top » near the
      // top of the screen was clamped down over its own trigger, under the pointer).
      if (side === 'top' || side === 'bottom') {
        const haut = t.top - GAP - MARGIN, bas = window.innerHeight - t.bottom - GAP - MARGIN
        const dessus = side === 'top' ? (h <= haut || haut >= bas) : !(h <= bas || bas >= haut)
        top = dessus ? t.top - GAP - h : t.bottom + GAP
        left = align === 'start' ? t.left : t.left + t.width / 2 - w / 2
      } else {
        const gauche = t.left - GAP - MARGIN, droite = window.innerWidth - t.right - GAP - MARGIN
        const aGauche = side === 'left' ? (w <= gauche || gauche >= droite) : !(w <= droite || droite >= gauche)
        top = t.top + t.height / 2 - h / 2
        left = aGauche ? t.left - GAP - w : t.right + GAP
      }
      // Keep it on screen.
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [isVisible, side, align, followCursor])

  return (
    <div
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={(e) => { cursor.current = { x: e.clientX, y: e.clientY }; showTooltip() }}
      onMouseMove={followCursor ? (e) => { cursor.current = { x: e.clientX, y: e.clientY }; if (isVisible) placeAtCursor() } : undefined}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {isVisible && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className={cn(
            'fixed z-[100] pointer-events-none px-3 py-1.5 text-xs font-medium text-popover-foreground bg-popover border rounded-md shadow-md animate-in fade-in-0 zoom-in-95',
          )}
        >
          {content}
        </div>,
        document.body,
      )}
    </div>
  )
}

export { Tooltip }
