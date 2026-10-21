import type { SVGProps } from 'react'

/** Outlined fabric-roll silhouette — a "tombé de métier" écru (greige) roll
 *  over the fabric it unrolls, nearly flat: the outline of `FiniRollIcon`,
 *  which is filled, so finished and unfinished rolls stay apart at a glance.
 *
 *  Drawn in Lucide's grammar (24 grid, stroke 2, round caps, currentColor) so
 *  it carries the same weight as the icons around it — the old CSS-masked
 *  `public/icons/tm.png` had a ~12 px line on a 680 px image, a hairline once
 *  shrunk to 16 px:
 *
 *    <TmRollIcon className="h-4 w-4 text-muted-foreground" />
 */
export function TmRollIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Roll end, with its core — same silhouette as FiniRollIcon, outlined */}
      <ellipse cx="6" cy="10.5" rx="3.8" ry="5.3" />
      <ellipse cx="6" cy="10.5" rx="1.2" ry="1.8" />
      {/* Roll body rising to the right: top edge, rounded far end, bottom edge */}
      <path d="M6 5.2l9.8-1.7c2.2-.4 3.4 1.7 3.4 4.2 0 2.4-1 4.2-2.7 4.6L6 15.8" />
      {/* Fabric running out flat under it, almost horizontal */}
      <path d="M9 18.2l12.6-4.2 1.4 1.4-12.2 4.4z" />
    </svg>
  )
}
