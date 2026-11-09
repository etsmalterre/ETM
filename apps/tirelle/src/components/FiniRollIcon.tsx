import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Filled fabric-roll silhouette — represents a "fini" (finished /
 *  dyed) roll. The PNG is masked into a `<span>` whose `bg-current`
 *  reads the text colour, so callers keep their existing API:
 *
 *    <FiniRollIcon className="h-4 w-4 text-green-700" />
 *
 *  Render-wise this matches the previous Lucide-style components and
 *  works inside the same flex/grid layouts that hosted `FabricRollIcon`.
 *  Copy of ETM's apps/web/src/components/icons/FiniRollIcon.tsx (same
 *  PNG, public/icons/fini.png) so both apps show the same roll.
 */
export function FiniRollIcon({ className, style, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="img"
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: "url('/icons/fini.png')",
        WebkitMaskImage: "url('/icons/fini.png')",
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        ...style,
      }}
      {...rest}
    />
  )
}
