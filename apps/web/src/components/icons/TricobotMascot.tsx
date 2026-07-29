// Tricobot, sitting directly on whatever is behind him — no frame, no plate.
//
// `/tricobot/tricobot-mascot.png` is prepared from the official transparent
// render on the shared drive:
//   Malterre Drive/ETM/Eléments Graphique/TricoBot/3D/no bg better res.png
// (1024², genuinely transparent — 69% fully clear, the rest is anti-aliasing,
// with no glow or drop shadow baked into the alpha, so he stays clean on the
// navy header band AND on the white tray chip).
//
// Preparation was only: trim to the alpha bounding box, pad to a square so a
// square icon box can't distort him, downscale to 512². If the character is
// ever re-exported, redo exactly that — do NOT try to key him out of the
// older opaque artwork (`tricobot-wave.png`, still used at full size by the
// Clients > Commandes pricing nudge). That was tried and it is a trap: he is a
// *white* yarn cone on a near-white backdrop, so only connectivity separates
// them, the fine yarn texture lets any gradient-based fill walk through his
// silhouette, and his cast shadow cannot be removed without also eating the
// cone. The transparent source exists — use it.
//
// Sizing comes entirely from `className`, so the same component serves the
// widget header and the hidden-widget tray chip.

import { cn } from '@/lib/utils'

export function TricobotMascot({ className }: { className?: string }) {
  return (
    <img
      src="/tricobot/tricobot-mascot.png"
      alt=""
      aria-hidden
      draggable={false}
      // object-contain, not cover: he is a tall figure on a square canvas, and
      // cover would crop his head or his feet at any non-square size.
      className={cn('flex-shrink-0 object-contain', className)}
    />
  )
}
