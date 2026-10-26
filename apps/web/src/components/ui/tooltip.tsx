import * as React from 'react'
import { cn } from '@/lib/utils'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** top / bottom only: 'start' pins the tooltip to the trigger's left edge
   *  instead of centering it — for a trigger near the left of a clipping panel. */
  align?: 'center' | 'start'
  delayDuration?: number
}

function Tooltip({
  content,
  children,
  side = 'right',
  align = 'center',
  delayDuration = 200,
}: TooltipProps) {
  const [isVisible, setIsVisible] = React.useState(false)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>()

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
  }

  const sideClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  }

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {isVisible && (
        <div
          role="tooltip"
          className={cn(
            'absolute z-50 px-3 py-1.5 text-xs font-medium text-popover-foreground bg-popover border rounded-md shadow-md animate-in fade-in-0 zoom-in-95',
            sideClasses[side],
            align === 'start' && (side === 'top' || side === 'bottom') && 'left-0 translate-x-0'
          )}
        >
          {content}
        </div>
      )}
    </div>
  )
}

export { Tooltip }
