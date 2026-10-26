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
}: TooltipProps) {
  const [isVisible, setIsVisible] = React.useState(false)
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>()
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)

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
    const place = () => {
      const trigger = triggerRef.current
      const tip = tipRef.current
      if (!trigger || !tip) return
      const t = trigger.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      let top: number
      let left: number
      if (side === 'top' || side === 'bottom') {
        top = side === 'top' ? t.top - GAP - h : t.bottom + GAP
        left = align === 'start' ? t.left : t.left + t.width / 2 - w / 2
      } else {
        top = t.top + t.height / 2 - h / 2
        left = side === 'left' ? t.left - GAP - w : t.right + GAP
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
  }, [isVisible, side, align])

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={showTooltip}
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
