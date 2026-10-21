import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Outlined fabric-roll silhouette — represents a "tombé de métier"
 *  écru (greige) roll. Visually distinct from `FiniRollIcon` (filled)
 *  so the user can tell finished and unfinished rolls apart at a glance
 *  inside the line drawer's Affectés / Réception tabs.
 *
 *  Like `FiniRollIcon`, this is a CSS-masked `<span>` so the icon
 *  inherits text colour:
 *
 *    <TmRollIcon className="h-4 w-4 text-muted-foreground" />
 *
 *  Source asset: `public/icons/tm.png` — the outline of `fini.png`, its lines
 *  thickened by 10 px (2026-10-21): the original ~12 px line on a 680 px image
 *  was a hairline at 16 px next to Lucide's stroke. Keep the PNG bold.
 */
export function TmRollIcon({ className, style, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="img"
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        maskImage: "url('/icons/tm.png')",
        WebkitMaskImage: "url('/icons/tm.png')",
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
